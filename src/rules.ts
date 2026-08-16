import type { ArchitectureCycle, ArchitectureFinding, ArchitectureModule, SourceImport } from "./ir.js";
import type { InspectorConfig } from "./project.js";
import { compare } from "./stable.js";

const levelRank = { error: 0, warning: 1, info: 2 } as const;

function evidenceForEdge(edge: SourceImport) {
  return [{ kind: "source-edge" as const, id: edge.id, file: edge.fromFile, line: edge.location.line }];
}

function derivedProvenance(rule: string, derivedFrom: string[], evidence: ReturnType<typeof evidenceForEdge>) {
  return {
    origin: "derived" as const,
    analyzer: "architecture-rules",
    rule,
    derivedFrom,
    evidence,
  };
}

export function evaluateRules(
  config: InspectorConfig,
  modules: ArchitectureModule[],
  imports: SourceImport[],
  fileToModule: Map<string, string>,
  moduleEntrypoints: Map<string, Set<string>>,
  cycles: ArchitectureCycle[],
): ArchitectureFinding[] {
  const findings: ArchitectureFinding[] = [];
  const noCycles = config.noCycles ?? true;
  const noDeepImports = config.noDeepImports ?? true;

  if (noCycles) {
    for (const cycle of cycles) {
      findings.push({
        code: "architecture/cycle",
        category: "violation",
        level: "error",
        message: `Module dependency strongly-connected component: ${cycle.modules.join(", ")}.`,
        related: cycle.modules,
        data: { modules: cycle.modules, edgeIds: cycle.edgeIds },
        provenance: {
          origin: "derived",
          analyzer: "architecture-rules",
          rule: "architecture/cycle",
          derivedFrom: cycle.edgeIds,
          evidence: cycle.edgeIds.map((id) => ({ kind: "module-edge" as const, id })),
        },
      });
    }
  }

  for (const edge of imports) {
    const fromModule = fileToModule.get(edge.fromFile);
    const toModule = edge.toFile ? fileToModule.get(edge.toFile) : undefined;
    if (
      edge.resolution === "unresolved" &&
      (edge.specifier.startsWith(".") || edge.specifier.startsWith("/") || edge.specifier.startsWith("#"))
    ) {
      findings.push({
        code: "architecture/unresolved-import",
        category: "observation",
        level: "warning",
        message: `Could not resolve internal import '${edge.specifier}'.`,
        file: edge.fromFile,
        line: edge.location.line,
        data: { specifier: edge.specifier },
        provenance: derivedProvenance("architecture/unresolved-import", [edge.id], evidenceForEdge(edge)),
      });
    }
    const publicApi = toModule ? moduleEntrypoints.get(toModule)?.has(edge.toFile ?? "") === true : false;
    if (
      noDeepImports &&
      edge.resolution === "internal" &&
      fromModule &&
      toModule &&
      fromModule !== toModule &&
      !publicApi
    ) {
      findings.push({
        code: "architecture/deep-import",
        category: "violation",
        level: "warning",
        message: `${fromModule} imports ${edge.toFile ?? edge.specifier} instead of ${toModule}'s public entrypoint.`,
        file: edge.fromFile,
        line: edge.location.line,
        data: { from: fromModule, to: toModule, target: edge.toFile },
        provenance: derivedProvenance("architecture/deep-import", [edge.id], evidenceForEdge(edge)),
      });
    }
  }

  for (const rule of config.forbiddenDependencies ?? []) {
    for (const edge of imports) {
      const fromModule = fileToModule.get(edge.fromFile);
      const toModule = edge.toFile ? fileToModule.get(edge.toFile) : undefined;
      if (fromModule === rule.from && toModule === rule.to && edge.resolution === "internal") {
        findings.push({
          code: "architecture/forbidden-dependency",
          category: "violation",
          level: "error",
          message: rule.message ?? `${rule.from} is not allowed to depend on ${rule.to}.`,
          file: edge.fromFile,
          line: edge.location.line,
          data: { from: rule.from, to: rule.to },
          provenance: derivedProvenance("architecture/forbidden-dependency", [edge.id], evidenceForEdge(edge)),
        });
      }
    }
  }

  for (const module of modules) {
    if (module.entrypoints.length === 0 && modules.length > 1) {
      findings.push({
        code: "architecture/no-public-entrypoint",
        category: "observation",
        level: "info",
        message: `Module '${module.id}' has no index entrypoint; cross-module imports cannot be checked as public API.`,
        related: [module.id],
        provenance: {
          origin: "derived",
          analyzer: "architecture-rules",
          rule: "architecture/no-public-entrypoint",
          evidence: [{ kind: "module", id: module.id }],
        },
      });
    }
  }

  return findings.sort(
    (a, b) =>
      levelRank[a.level] - levelRank[b.level] ||
      compare(a.code, b.code) ||
      compare(a.file ?? "", b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      compare(a.message, b.message),
  );
}

export function findingKey(finding: ArchitectureFinding): string {
  return [
    finding.code,
    finding.category,
    finding.file ?? "",
    finding.line ?? 0,
    finding.message,
    ...(finding.provenance.derivedFrom ?? []),
  ].join("\0");
}

/** Return true only when an explicit check policy selects this finding. */
export function matchesFailOn(finding: ArchitectureFinding, failOn: string[]): boolean {
  if (failOn.length === 0) return false;
  if (failOn.includes("all")) return finding.category === "violation";
  if (failOn.includes("violations") && finding.category === "violation") return true;
  const aliases: Record<string, string> = {
    cycles: "architecture/cycle",
    cycle: "architecture/cycle",
    "deep-imports": "architecture/deep-import",
    "deep-import": "architecture/deep-import",
    "forbidden-dependencies": "architecture/forbidden-dependency",
    "forbidden-dependency": "architecture/forbidden-dependency",
  };
  return failOn.some((selector) => {
    const normalized = aliases[selector] ?? selector;
    return normalized === finding.code || normalized === finding.code.replace("architecture/", "");
  });
}
