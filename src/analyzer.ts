import path from "node:path";
import type { ModuleResolutionCache, SourceAstCache } from "./imports.js";
import {
  IR_VERSION,
  TOOL_VERSION,
  type ArchitectureFinding,
  type ArchitectureMetrics,
  type ArchitectureSnapshot,
  type SourceFile,
  type SourceImport,
} from "./ir.js";
import { assertArchitectureSnapshot } from "./ir-contract.js";
import { discoverProject, isWithin, relativeToRoot, type DiscoveredProject } from "./project.js";
import {
  BUILTIN_PIPELINE,
  BUILTIN_FACT_PROVIDERS,
  clonePipelineManifest,
  collectFacts,
  declarativeArchitectureProjector,
  hashPipeline,
  moduleGraphProjector,
  moduleInferenceProjector,
  ownershipProjector,
} from "./pipeline.js";
import { BUILTIN_RULES, evaluateRules } from "./rules.js";
import { sha256 } from "./stable.js";
import { buildTypeAwareImportIndex, type TypeAwareImportIndex } from "./type-aware.js";

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
  const implementationImports = imports.filter((edge) => edge.purpose !== "architecture-declaration");
  return {
    sourceFiles: project.files.length,
    modules: modules.length,
    imports: implementationImports.length,
    internalImports: implementationImports.filter((edge) => edge.resolution === "internal").length,
    externalImports: implementationImports.filter((edge) => edge.resolution === "external").length,
    assetImports: implementationImports.filter((edge) => edge.resolution === "asset").length,
    unresolvedImports: implementationImports.filter((edge) => edge.resolution === "unresolved").length,
    outOfScopeImports: implementationImports.filter((edge) => edge.resolution === "out-of-scope").length,
    moduleEdges: moduleEdges.length,
    cycles: cycles.length,
    deepImports: moduleEdges.reduce((total, edge) => total + edge.deepImports, 0),
    unknownVisibilityImports: moduleEdges.reduce((total, edge) => total + edge.unknownImports, 0),
    maxFanIn: highest(fanIn),
    maxFanOut: highest(fanOut),
    provenance: { origin: "derived", analyzer: "architecture-metrics" },
  };
}

function inputHash(project: DiscoveredProject): string {
  return sha256({
    files: project.files.map((file) => ({
      path: relativeToRoot(project.root, file),
      content: project.fileContents.get(file) ?? "",
    })),
    packageJson: [...project.packageJsonContents.entries()]
      .map(([file, content]) => ({ path: relativeToRoot(project.root, file), content }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
}

/**
 * TypeScript resolves several compiler options to absolute paths (rootDir,
 * outDir, baseUrl, pathsBasePath, configFilePath, typeRoots, ...). Those
 * paths differ when the same Git tree is unpacked into a temporary directory,
 * even though the compiler context is semantically identical. Normalize only
 * paths inside the project root so external toolchain paths retain their
 * meaning.
 */
function normalizeCompilerOptions(value: unknown, projectRoot: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeCompilerOptions(entry, projectRoot));
  if (typeof value === "string" && path.isAbsolute(value)) {
    const normalized = path.normalize(value);
    return isWithin(projectRoot, normalized) ? relativeToRoot(projectRoot, normalized) : value;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeCompilerOptions(entry, projectRoot)]),
    );
  }
  return value;
}

function normalizedCompilerContexts(project: DiscoveredProject): unknown {
  return [...project.compilerOptionsByConfig.entries()]
    .map(([configPath, options]) => ({
      config: relativeToRoot(project.root, configPath),
      options: normalizeCompilerOptions(options, project.root),
    }))
    .sort((left, right) => left.config.localeCompare(right.config));
}

function createReceipt(
  base: Omit<ArchitectureSnapshot, "receipt">,
  project: DiscoveredProject,
): ArchitectureSnapshot["receipt"] {
  const pipeline = clonePipelineManifest(BUILTIN_PIPELINE);
  const receiptBase = {
    tool: "arch-inspector" as const,
    toolVersion: TOOL_VERSION,
    irVersion: IR_VERSION,
    configHash: sha256(project.config),
    compilerOptionsHash: sha256({
      default: normalizeCompilerOptions(project.compilerOptions, project.root),
      configurations: normalizedCompilerContexts(project),
    }),
    inputHash: inputHash(project),
    pipeline,
    pipelineHash: hashPipeline(pipeline),
  };
  return {
    ...receiptBase,
    snapshotId: sha256({ ...base, receipt: { ...receiptBase, snapshotId: "" } }),
  };
}

function projectSignature(project: DiscoveredProject): string {
  return sha256({
    root: project.root,
    tsconfigPath: project.tsconfigPath,
    sourceRoot: project.sourceRoot,
    config: project.config,
    files: project.files.map((file) => ({
      path: relativeToRoot(project.root, file),
      content: project.fileContents.get(file) ?? "",
    })),
    compilerOptions: project.compilerOptions,
    compilerOptionsByConfig: [...project.compilerOptionsByConfig.entries()]
      .map(([configPath, options]) => [relativeToRoot(project.root, configPath), options] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    tsconfigPathByFile: [...project.tsconfigPathByFile.entries()]
      .map(
        ([file, configPath]) => [relativeToRoot(project.root, file), relativeToRoot(project.root, configPath)] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
    filesByConfig: [...project.filesByConfig.entries()]
      .map(
        ([configPath, files]) =>
          [relativeToRoot(project.root, configPath), files.map((file) => relativeToRoot(project.root, file))] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
    packageJson: [...project.packageJsonContents.entries()]
      .map(([file, content]) => [relativeToRoot(project.root, file), content] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    projectPackageNames: [...project.projectPackageNames].sort(),
    externalPackageNames: [...project.externalPackageNames].sort(),
  });
}

function analyzeDiscoveredProject(
  project: DiscoveredProject,
  typeAware: TypeAwareImportIndex | undefined,
  sourceAstCache: SourceAstCache,
  resolutionCache: ModuleResolutionCache,
): ArchitectureSnapshot {
  const factStore = collectFacts({ project, typeAware, sourceAstCache, resolutionCache }, BUILTIN_FACT_PROVIDERS);
  const files = [...factStore.facts<SourceFile>("source.files")];
  const imports = [...factStore.facts<SourceImport>("source.imports")];
  const declarations = [
    ...factStore.facts<import("./declarations.js").ModuleDeclarationFact>("architecture.declarations"),
  ];
  const moduleFacts = moduleInferenceProjector.project({ project, declarations });
  const fileToModule = new Map(moduleFacts.fileToModule);
  const moduleEntrypoints = new Map(
    moduleFacts.moduleEntrypoints.map(([module, entrypoints]) => [module, new Set(entrypoints)] as const),
  );
  const moduleGraph = moduleGraphProjector.project({
    modules: moduleFacts.modules,
    imports,
    fileToModule,
    moduleEntrypoints,
  });
  const { moduleEdges, cycles } = moduleGraph;
  const declarative = declarativeArchitectureProjector.project({
    modules: moduleFacts.modules,
    declarations,
    moduleEdges,
    projectRoot: project.root,
  });
  const findings: ArchitectureFinding[] = evaluateRules({
    config: project.config,
    modules: [...moduleFacts.modules],
    moduleEdges,
    imports,
    fileToModule,
    moduleEntrypoints,
    cycles,
    declaredDependencies: declarative.declaredDependencies,
    contracts: declarative.contracts,
    interactions: declarative.interactions,
    dependencyConformance: declarative.dependencyConformance,
    declaredCycles: declarative.declaredCycles,
  });
  const ownership = ownershipProjector.project({ files, fileToModule });
  const projectFacts = {
    root: ".",
    tsconfig: relativeToRoot(project.root, project.tsconfigPath),
    sourceRoot: relativeToRoot(project.root, project.sourceRoot),
  };
  const policy = {
    failOn: [...(project.config.failOn ?? [])].sort(),
    knownRuleCodes: [
      ...new Set([
        ...BUILTIN_RULES.map((rule) => rule.code),
        ...(project.config.rules ?? []).map((rule) => rule.code),
        ...(project.config.rulePacks ?? []).flatMap((pack) => pack.rules.map((rule) => rule.code)),
      ]),
    ].sort(),
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
    modules: [...moduleFacts.modules],
    ownership,
    moduleEdges,
    contracts: declarative.contracts,
    declaredDependencies: declarative.declaredDependencies,
    interactions: declarative.interactions,
    provenance: { origin: "derived" as const, analyzer: "module-projection" },
  };
  const analysis = {
    cycles,
    declaredCycles: declarative.declaredCycles,
    dependencyConformance: declarative.dependencyConformance,
    metrics: metrics(project, [...moduleFacts.modules], imports, moduleEdges, cycles),
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

interface SessionEntry {
  signature: string;
  project: DiscoveredProject;
  sourceAstCache: SourceAstCache;
  resolutionCache: ModuleResolutionCache;
  typeAware?: TypeAwareImportIndex;
}

/**
 * Reusable analysis context. Discovery still runs on every call so file and
 * config changes are visible, while unchanged projects reuse parsed ASTs and
 * the optional TypeScript checker index.
 */
export class AnalyzerSession {
  private readonly entries = new Map<string, SessionEntry>();

  analyze(inputPath = "."): ArchitectureSnapshot {
    const discovered = discoverProject(inputPath);
    const key = discovered.root;
    const signature = projectSignature(discovered);
    const previous = this.entries.get(key);
    const entry =
      previous?.signature === signature
        ? previous
        : {
            signature,
            project: discovered,
            sourceAstCache: new Map<string, import("typescript").SourceFile>(),
            resolutionCache: new Map(),
            typeAware: discovered.config.typeAware ? buildTypeAwareImportIndex(discovered) : undefined,
          };
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Keep long-lived editor/CI sessions bounded when they visit many roots.
    while (this.entries.size > 8) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return analyzeDiscoveredProject(entry.project, entry.typeAware, entry.sourceAstCache, entry.resolutionCache);
  }
}

export function createAnalyzerSession(): AnalyzerSession {
  return new AnalyzerSession();
}

export function analyzeProject(inputPath = "."): ArchitectureSnapshot {
  return createAnalyzerSession().analyze(inputPath);
}
