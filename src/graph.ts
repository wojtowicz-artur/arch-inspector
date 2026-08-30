import type { ArchitectureCycle, ArchitectureModule, ArchitectureSnapshot, ModuleEdge, SourceImport } from "./ir.js";
import { compare } from "./stable.js";

export function buildModuleEdges(
  imports: SourceImport[],
  fileToModule: Map<string, string>,
  moduleEntrypoints: Map<string, Set<string>>,
): ModuleEdge[] {
  const grouped = new Map<string, ModuleEdge>();
  for (const edge of imports) {
    if (edge.resolution !== "internal" || !edge.toFile) continue;
    const from = fileToModule.get(edge.fromFile);
    const to = fileToModule.get(edge.toFile);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    const current: ModuleEdge = grouped.get(key) ?? {
      id: key,
      from,
      to,
      imports: 0,
      publicApiImports: 0,
      deepImports: 0,
      unknownImports: 0,
      files: [],
      sourceEdgeIds: [],
      visibility: "unknown" as const,
      provenance: {
        origin: "derived" as const,
        analyzer: "module-projection",
      },
    };
    const entrypoints = moduleEntrypoints.get(to);
    const publicApiKnown = (entrypoints?.size ?? 0) > 0;
    const publicApi = entrypoints?.has(edge.toFile) === true;
    current.imports += 1;
    if (!publicApiKnown) current.unknownImports += 1;
    else if (publicApi) current.publicApiImports += 1;
    else current.deepImports += 1;
    if (!current.files.includes(edge.fromFile)) current.files.push(edge.fromFile);
    if (!current.sourceEdgeIds.includes(edge.id)) current.sourceEdgeIds.push(edge.id);
    const visibilityKinds = [
      current.publicApiImports > 0 ? "public" : undefined,
      current.deepImports > 0 ? "deep" : undefined,
      current.unknownImports > 0 ? "unknown" : undefined,
    ].filter((value): value is "public" | "deep" | "unknown" => value !== undefined);
    current.visibility = visibilityKinds.length === 1 ? visibilityKinds[0] : "mixed";
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((edge) => ({
      ...edge,
      files: [...edge.files].sort(compare),
      sourceEdgeIds: [...edge.sourceEdgeIds].sort(compare),
      provenance: {
        ...edge.provenance,
        derivedFrom: [...edge.sourceEdgeIds].sort(compare),
        evidence: edge.sourceEdgeIds.map((id) => ({ kind: "source-edge" as const, id })),
      },
    }))
    .sort((a, b) => compare(a.id, b.id));
}

export function findCycles(modules: ArchitectureModule[], moduleEdges: ModuleEdge[]): ArchitectureCycle[] {
  const adjacency = new Map(modules.map((module) => [module.id, [] as string[]]));
  for (const edge of moduleEdges) adjacency.get(edge.from)?.push(edge.to);
  for (const values of adjacency.values()) values.sort(compare);

  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(next)!));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(next)!));
      }
    }
    if (lowLinks.get(node) === indices.get(node)) {
      const component: string[] = [];
      let current: string;
      do {
        current = stack.pop()!;
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      if (component.length > 1) components.push(component.sort(compare));
    }
  };

  for (const module of [...modules].sort((a, b) => compare(a.id, b.id))) {
    if (!indices.has(module.id)) visit(module.id);
  }

  return components
    .sort((a, b) => compare(a.join("\0"), b.join("\0")))
    .map((members) => {
      const memberSet = new Set(members);
      const edgeIds = moduleEdges
        .filter((edge) => memberSet.has(edge.from) && memberSet.has(edge.to))
        .map((edge) => edge.id)
        .sort(compare);
      const id = members.join("\0");
      return {
        id,
        modules: members,
        edgeIds,
        provenance: {
          origin: "derived" as const,
          analyzer: "tarjan-scc",
          derivedFrom: edgeIds,
          evidence: edgeIds.map((edgeId) => ({ kind: "module-edge" as const, id: edgeId })),
        },
      };
    });
}

function dotString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

/**
 * Render the module graph as deterministic Graphviz DOT.
 *
 * The output intentionally uses only the Architecture IR, so it can be
 * rendered by Graphviz or consumed by other visualization tools without
 * requiring access to the analyzed project.
 */
export function renderModuleGraphDot(snapshot: Pick<ArchitectureSnapshot, "architecture" | "analysis">): string {
  const { modules, moduleEdges } = snapshot.architecture;
  const cycleModules = new Set(snapshot.analysis.cycles.flatMap((cycle) => cycle.modules));
  const lines = [
    "digraph architecture {",
    "  rankdir=LR;",
    '  graph [fontname="sans-serif", bgcolor="transparent"];',
    '  node [shape=box, fontname="sans-serif"];',
    '  edge [fontname="sans-serif"];',
  ];

  for (const module of [...modules].sort((a, b) => compare(a.id, b.id))) {
    const attributes = [
      `label=${dotString(`${module.id}\n${module.files.length} file${module.files.length === 1 ? "" : "s"}`)}`,
    ];
    if (cycleModules.has(module.id)) {
      attributes.push('color="#dc2626"', 'penwidth="2"');
    }
    lines.push(`  ${dotString(module.id)} [${attributes.join(", ")}];`);
  }

  for (const edge of [...moduleEdges].sort((a, b) => compare(a.id, b.id))) {
    const visibility =
      edge.publicApiImports === edge.imports
        ? "public API"
        : [
            edge.publicApiImports > 0 ? `${edge.publicApiImports} public API` : undefined,
            edge.deepImports > 0 ? `${edge.deepImports} deep` : undefined,
            edge.unknownImports > 0 ? `${edge.unknownImports} unknown` : undefined,
          ]
            .filter((value): value is string => value !== undefined)
            .join(", ");
    lines.push(
      `  ${dotString(edge.from)} -> ${dotString(edge.to)} [label=${dotString(`${edge.imports} (${visibility})`)}];`,
    );
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}
