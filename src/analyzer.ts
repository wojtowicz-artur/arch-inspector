import path from "node:path";
import ts from "typescript";
import { collectEdges } from "./imports.js";
import { IR_VERSION, type ArchitectureFile, type ArchitectureMetrics, type ArchitectureSnapshot } from "./ir.js";
import { buildModuleEdges, findCycles } from "./graph.js";
import { inferModules } from "./modules.js";
import { discoverProject, relativeToRoot, type DiscoveredProject } from "./project.js";
import { evaluateRules } from "./rules.js";

function languageFor(file: string): "typescript" | "javascript" {
  return /\.(?:jsx?|mjs|cjs)$/i.test(file) ? "javascript" : "typescript";
}

function linesIn(file: string): number {
  const text = ts.sys.readFile(file) ?? "";
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

function metrics(project: DiscoveredProject, modules: ArchitectureSnapshot["modules"], edges: ArchitectureSnapshot["edges"], moduleEdges: ArchitectureSnapshot["moduleEdges"], cycles: string[][]): ArchitectureMetrics {
  const fanIn = new Map(modules.map((module) => [module.id, 0]));
  const fanOut = new Map(modules.map((module) => [module.id, 0]));
  for (const edge of moduleEdges) {
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }
  const highest = (values: Map<string, number>): { module: string; value: number } | null => {
    if (values.size === 0) return null;
    const [module, value] = [...values.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0];
    return { module, value };
  };
  return {
    sourceFiles: project.files.length,
    modules: modules.length,
    imports: edges.length,
    internalImports: edges.filter((edge) => edge.resolution === "internal").length,
    externalImports: edges.filter((edge) => edge.resolution === "external").length,
    assetImports: edges.filter((edge) => edge.resolution === "asset").length,
    unresolvedImports: edges.filter((edge) => edge.resolution === "unresolved").length,
    moduleEdges: moduleEdges.length,
    cycles: cycles.length,
    deepImports: edges.filter((edge) => edge.resolution === "internal" && edge.fromModule !== edge.toModule && !edge.publicApi).length,
    maxFanIn: highest(fanIn),
    maxFanOut: highest(fanOut),
  };
}

export function analyzeProject(inputPath = "."): ArchitectureSnapshot {
  const project = discoverProject(inputPath);
  const inferred = inferModules(project);
  const moduleEntrypoints = new Map(inferred.modules.map((module) => [module.id, new Set(module.entrypoints.map((file) => path.normalize(path.join(project.root, file))))]));
  const edges = collectEdges(project, inferred.fileToModule, moduleEntrypoints);
  const moduleEdges = buildModuleEdges(edges);
  const cycles = findCycles(inferred.modules, moduleEdges);
  const diagnostics = evaluateRules(project.config, inferred.modules, edges, cycles);
  const files: ArchitectureFile[] = project.files.map((file) => ({
    path: relativeToRoot(project.root, file),
    moduleId: inferred.fileToModule.get(file)!,
    language: languageFor(file),
    lines: linesIn(file),
  })).sort((a, b) => a.path.localeCompare(b.path));

  const snapshot: ArchitectureSnapshot = {
    irVersion: IR_VERSION,
    project: {
      root: ".",
      tsconfig: relativeToRoot(project.root, project.tsconfigPath),
      sourceRoot: relativeToRoot(project.root, project.sourceRoot),
    },
    modules: inferred.modules,
    files,
    edges,
    moduleEdges,
    cycles,
    metrics: metrics(project, inferred.modules, edges, moduleEdges, cycles),
    diagnostics,
  };
  return snapshot;
}
