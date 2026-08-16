import type { ArchitectureDiagnostic, ArchitectureEdge, ArchitectureModule } from "./ir.js";
import type { InspectorConfig } from "./project.js";

const levelRank = { error: 0, warning: 1, info: 2 } as const;

export function evaluateRules(
  config: InspectorConfig,
  modules: ArchitectureModule[],
  edges: ArchitectureEdge[],
  cycles: string[][],
): ArchitectureDiagnostic[] {
  const diagnostics: ArchitectureDiagnostic[] = [];
  const noCycles = config.noCycles ?? true;
  const noDeepImports = config.noDeepImports ?? true;

  if (noCycles) {
    for (const cycle of cycles) {
      diagnostics.push({
        code: "architecture/cycle",
        category: "violation",
        level: "error",
        message: `Module dependency cycle: ${cycle.join(" → ")} → ${cycle[0]}`,
        related: cycle,
        data: { modules: cycle },
      });
    }
  }

  for (const edge of edges) {
    if (edge.resolution === "unresolved" && (edge.specifier.startsWith(".") || edge.specifier.startsWith("/") || edge.specifier.startsWith("#"))) {
      diagnostics.push({
        code: "architecture/unresolved-import",
        category: "observation",
        level: "warning",
        message: `Could not resolve internal import '${edge.specifier}'.`,
        file: edge.fromFile,
        line: edge.location.line,
        data: { specifier: edge.specifier },
      });
    }
    if (noDeepImports && edge.resolution === "internal" && edge.fromModule !== edge.toModule && !edge.publicApi) {
      diagnostics.push({
        code: "architecture/deep-import",
        category: "violation",
        level: "warning",
        message: `${edge.fromModule} imports ${edge.toFile ?? edge.specifier} instead of ${edge.toModule}'s public entrypoint.`,
        file: edge.fromFile,
        line: edge.location.line,
        data: { from: edge.fromModule, to: edge.toModule, target: edge.toFile },
      });
    }
  }

  for (const rule of config.forbiddenDependencies ?? []) {
    for (const edge of edges) {
      if (edge.fromModule === rule.from && edge.toModule === rule.to && edge.resolution === "internal") {
        diagnostics.push({
          code: "architecture/forbidden-dependency",
          category: "violation",
          level: "error",
          message: rule.message ?? `${rule.from} is not allowed to depend on ${rule.to}.`,
          file: edge.fromFile,
          line: edge.location.line,
          data: { from: rule.from, to: rule.to },
        });
      }
    }
  }

  for (const module of modules) {
    if (module.entrypoints.length === 0 && modules.length > 1) {
      diagnostics.push({
        code: "architecture/no-public-entrypoint",
        category: "observation",
        level: "info",
        message: `Module '${module.id}' has no index entrypoint; cross-module imports cannot be checked as public API.`,
        related: [module.id],
      });
    }
  }

  return diagnostics.sort((a, b) => (levelRank[a.level] - levelRank[b.level]) || a.code.localeCompare(b.code) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.message.localeCompare(b.message));
}
