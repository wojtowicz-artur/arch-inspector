import type { ArchitectureEdge, ArchitectureModule, ArchitectureSnapshot, ModuleEdge } from "./ir.js";

export function buildModuleEdges(edges: ArchitectureEdge[]): ModuleEdge[] {
  const grouped = new Map<string, ModuleEdge>();
  for (const edge of edges) {
    if (edge.resolution !== "internal" || !edge.toModule || edge.fromModule === edge.toModule) continue;
    const key = `${edge.fromModule}\0${edge.toModule}`;
    const current = grouped.get(key) ?? { from: edge.fromModule, to: edge.toModule, imports: 0, publicApiImports: 0, files: [], provenance: { origin: "derived" as const } };
    current.imports += 1;
    if (edge.publicApi) current.publicApiImports += 1;
    if (!current.files.includes(edge.fromFile)) current.files.push(edge.fromFile);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((edge) => ({ ...edge, files: edge.files.sort() })).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
}

export function findCycles(modules: ArchitectureModule[], moduleEdges: ModuleEdge[]): string[][] {
  const adjacency = new Map(modules.map((module) => [module.id, [] as string[]]));
  for (const edge of moduleEdges) adjacency.get(edge.from)?.push(edge.to);
  for (const values of adjacency.values()) values.sort();

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
      if (component.length > 1) components.push(component.sort());
    }
  };

  for (const module of modules) if (!indices.has(module.id)) visit(module.id);
  return components.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

function dotString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", '\\"').replaceAll("\n", "\\n")}"`;
}

/**
 * Render the module graph as deterministic Graphviz DOT.
 *
 * The output intentionally uses only the Architecture IR, so it can be
 * rendered by Graphviz or consumed by other visualization tools without
 * requiring access to the analyzed project.
 */
export function renderModuleGraphDot(snapshot: Pick<ArchitectureSnapshot, "architecture">): string {
  const { modules, moduleEdges, cycles } = snapshot.architecture;
  const cycleModules = new Set(cycles.flatMap((cycle) => cycle.modules));
  const lines = [
    "digraph architecture {",
    "  rankdir=LR;",
    "  graph [fontname=\"sans-serif\", bgcolor=\"transparent\"];",
    "  node [shape=box, fontname=\"sans-serif\"];",
    "  edge [fontname=\"sans-serif\"];",
  ];

  for (const module of [...modules].sort((a, b) => a.id.localeCompare(b.id))) {
    const attributes = [`label=${dotString(`${module.id}\n${module.files.length} file${module.files.length === 1 ? "" : "s"}`)}`];
    if (cycleModules.has(module.id)) {
      attributes.push("color=\"#dc2626\"", "penwidth=\"2\"");
    }
    lines.push(`  ${dotString(module.id)} [${attributes.join(", ")}];`);
  }

  for (const edge of [...moduleEdges].sort((a, b) => `${a.from}\0${a.to}`.localeCompare(`${b.from}\0${b.to}`))) {
    const publicApi = edge.publicApiImports === edge.imports ? "public API" : `${edge.publicApiImports}/${edge.imports} public API`;
    lines.push(`  ${dotString(edge.from)} -> ${dotString(edge.to)} [label=${dotString(`${edge.imports} (${publicApi})`)}];`);
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}
