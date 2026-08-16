import ts from "typescript";
import { collectEdges } from "./imports.js";
import {
  IR_VERSION,
  TOOL_VERSION,
  type ArchitectureFinding,
  type ArchitectureMetrics,
  type ArchitectureSnapshot,
  type SourceFile,
} from "./ir.js";
import { assertArchitectureSnapshot } from "./ir-contract.js";
import { buildModuleEdges, findCycles } from "./graph.js";
import { inferModules } from "./modules.js";
import { discoverProject, relativeToRoot, type DiscoveredProject } from "./project.js";
import { evaluateRules } from "./rules.js";
import { sha256 } from "./stable.js";

function languageFor(file: string): "typescript" | "javascript" {
  return /\.(?:jsx?|mjs|cjs)$/i.test(file) ? "javascript" : "typescript";
}

function linesIn(file: string): number {
  const text = ts.sys.readFile(file) ?? "";
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

function highest(values: Map<string, number>): { module: string; value: number } | null {
  if (values.size === 0) return null;
  const [module, value] = [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { module, value };
}

function metrics(
  project: DiscoveredProject,
  modules: ArchitectureSnapshot["architecture"]["modules"],
  imports: ArchitectureSnapshot["source"]["imports"],
  moduleEdges: ArchitectureSnapshot["architecture"]["moduleEdges"],
  cycles: ArchitectureSnapshot["analysis"]["cycles"],
): ArchitectureMetrics {
  const fanIn = new Map(modules.map((module) => [module.id, 0]));
  const fanOut = new Map(modules.map((module) => [module.id, 0]));
  for (const edge of moduleEdges) {
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }
  return {
    sourceFiles: project.files.length,
    modules: modules.length,
    imports: imports.length,
    internalImports: imports.filter((edge) => edge.resolution === "internal").length,
    externalImports: imports.filter((edge) => edge.resolution === "external").length,
    assetImports: imports.filter((edge) => edge.resolution === "asset").length,
    unresolvedImports: imports.filter((edge) => edge.resolution === "unresolved").length,
    moduleEdges: moduleEdges.length,
    cycles: cycles.length,
    deepImports: moduleEdges.reduce((total, edge) => total + edge.deepImports, 0),
    maxFanIn: highest(fanIn),
    maxFanOut: highest(fanOut),
    provenance: { origin: "derived", analyzer: "architecture-metrics" },
  };
}

function sourceFiles(project: DiscoveredProject): SourceFile[] {
  return project.files
    .map((file) => {
      const relative = relativeToRoot(project.root, file);
      return {
        path: relative,
        language: languageFor(file),
        lines: linesIn(file),
        provenance: {
          origin: "observed" as const,
          analyzer: "typescript-source",
          evidence: [{ kind: "file" as const, id: relative, file: relative }],
        },
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function inputHash(project: DiscoveredProject): string {
  return sha256(
    project.files.map((file) => ({
      path: relativeToRoot(project.root, file),
      content: ts.sys.readFile(file) ?? "",
    })),
  );
}

function createReceipt(
  base: Omit<ArchitectureSnapshot, "receipt">,
  project: DiscoveredProject,
): ArchitectureSnapshot["receipt"] {
  const receiptBase = {
    tool: "arch-inspector" as const,
    toolVersion: TOOL_VERSION,
    irVersion: IR_VERSION,
    configHash: sha256(project.config),
    compilerOptionsHash: sha256(project.compilerOptions),
    inputHash: inputHash(project),
  };
  return {
    ...receiptBase,
    snapshotId: sha256({ ...base, receipt: { ...receiptBase, snapshotId: "" } }),
  };
}

export function analyzeProject(inputPath = "."): ArchitectureSnapshot {
  const project = discoverProject(inputPath);
  const inferred = inferModules(project);
  const relativeFileToModule = new Map(
    [...inferred.fileToModule.entries()].map(([file, module]) => [relativeToRoot(project.root, file), module]),
  );
  const moduleEntrypoints = new Map(inferred.modules.map((module) => [module.id, new Set(module.entrypoints)]));
  const imports = collectEdges(project);
  const moduleEdges = buildModuleEdges(imports, relativeFileToModule, moduleEntrypoints);
  const cycles = findCycles(inferred.modules, moduleEdges);
  const findings: ArchitectureFinding[] = evaluateRules({
    config: project.config,
    modules: inferred.modules,
    imports,
    fileToModule: relativeFileToModule,
    moduleEntrypoints,
    cycles,
  });
  const files = sourceFiles(project);
  const ownership = files.map((file) => ({
    file: file.path,
    module: relativeFileToModule.get(file.path)!,
    provenance: {
      origin: "inferred" as const,
      analyzer: "module-inference",
      evidence: [{ kind: "file" as const, id: file.path, file: file.path }],
    },
  }));
  const projectFacts = {
    root: ".",
    tsconfig: relativeToRoot(project.root, project.tsconfigPath),
    sourceRoot: relativeToRoot(project.root, project.sourceRoot),
  };
  const policy = {
    failOn: [...(project.config.failOn ?? [])].sort(),
    provenance: {
      origin: "declared" as const,
      analyzer: "arch.config.json",
      evidence: [{ kind: "config" as const, id: "policy" }],
    },
  };
  const source = {
    files,
    imports,
    provenance: { origin: "observed" as const, analyzer: "typescript-source" },
  };
  const architecture = {
    modules: inferred.modules,
    ownership,
    moduleEdges,
    provenance: { origin: "derived" as const, analyzer: "module-projection" },
  };
  const analysis = {
    cycles,
    metrics: metrics(project, inferred.modules, imports, moduleEdges, cycles),
    findings,
    provenance: { origin: "derived" as const, analyzer: "architecture-analysis" },
  };
  const base: Omit<ArchitectureSnapshot, "receipt"> = {
    irVersion: IR_VERSION,
    project: projectFacts,
    policy,
    source,
    architecture,
    analysis,
  };
  return assertArchitectureSnapshot(
    { ...base, receipt: createReceipt(base, project) },
    "Generated architecture snapshot",
  );
}
