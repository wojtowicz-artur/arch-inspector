import type { ModuleResolutionCache, SourceAstCache } from "./imports.js";
import { collectEdges } from "./imports.js";
import {
  TOOL_VERSION,
  type ArchitectureCycle,
  type ArchitectureModule,
  type FileOwnership,
  type ModuleEdge,
  type PipelineComponent,
  type PipelineManifest,
  type SourceFile,
  type SourceImport,
} from "./ir.js";
import { buildModuleEdges, findCycles } from "./graph.js";
import { projectDeclarativeArchitecture, type DeclarativeArchitectureProjection } from "./architecture.js";
import { inferModulesWithDeclarations } from "./modules.js";
import { collectModuleDeclarations, type ModuleDeclarationFact } from "./declarations.js";
import { relativeToRoot, type DiscoveredProject } from "./project.js";
import { sha256 } from "./stable.js";
import type { TypeAwareImportIndex } from "./type-aware.js";

export interface FactBatch<TFact> {
  source: {
    id: string;
    version: string;
  };
  facts: readonly TFact[];
}

export interface AnalysisContext {
  readonly project: DiscoveredProject;
  readonly sourceAstCache: SourceAstCache;
  readonly resolutionCache: ModuleResolutionCache;
  readonly typeAware?: TypeAwareImportIndex;
}

export interface FactProvider<TFact> {
  readonly id: string;
  readonly version: string;
  readonly factKind: string;
  collect(context: AnalysisContext): FactBatch<TFact>;
}

export interface Projector<TInput, TOutput> {
  readonly id: string;
  readonly version: string;
  project(input: TInput): TOutput;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  if (value instanceof Map || value instanceof Set || value instanceof Date) {
    throw new Error("Facts must use immutable records and arrays, not mutable collection objects.");
  }
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested, seen);
  return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  return freezeDeep(structuredClone(value));
}

/**
 * Internal normalized fact store. Batches are append-only and kept ordered by
 * provider identity so future providers cannot silently replace one another.
 * Stored JSON-like facts are cloned and deeply frozen at the boundary.
 */
export class FactStore {
  private readonly batchesByKind = new Map<string, FactBatch<unknown>[]>();

  add<TFact>(factKind: string, batch: FactBatch<TFact>): void {
    if (factKind.trim() === "") throw new Error("Fact kind must not be empty.");
    if (batch.source.id.trim() === "" || batch.source.version.trim() === "") {
      throw new Error(`Fact batch '${factKind}' must declare a source id and version.`);
    }

    const current = this.batchesByKind.get(factKind) ?? [];
    if (current.some((entry) => entry.source.id === batch.source.id)) {
      throw new Error(
        `Fact provider '${batch.source.id}' already supplied '${factKind}' facts; versions cannot be combined.`,
      );
    }

    const stored = Object.freeze({
      source: Object.freeze({ ...batch.source }),
      facts: Object.freeze(batch.facts.map(cloneAndFreeze)),
    }) as FactBatch<TFact>;
    const next = [...current, stored].sort(
      (left, right) =>
        left.source.id.localeCompare(right.source.id) || left.source.version.localeCompare(right.source.version),
    );
    this.batchesByKind.set(factKind, next);
  }

  batches<TFact>(factKind: string): readonly FactBatch<TFact>[] {
    const batches = this.batchesByKind.get(factKind) ?? [];
    return Object.freeze(
      batches.map((batch) =>
        Object.freeze({
          source: Object.freeze({ ...batch.source }),
          facts: batch.facts,
        }),
      ),
    ) as readonly FactBatch<TFact>[];
  }

  facts<TFact>(factKind: string): readonly TFact[] {
    return this.batches<TFact>(factKind).flatMap((batch) => batch.facts);
  }

  requireOne<TFact>(factKind: string): TFact {
    const values = this.facts<TFact>(factKind);
    if (values.length !== 1) {
      throw new Error(`Fact kind '${factKind}' expected exactly one fact, received ${values.length}.`);
    }
    return values[0]!;
  }
}

export function collectProvider<TFact>(
  store: FactStore,
  provider: FactProvider<TFact>,
  context: AnalysisContext,
): void {
  const batch = provider.collect(context);
  if (batch.source.id !== provider.id || batch.source.version !== provider.version) {
    throw new Error(
      `Fact provider '${provider.id}' returned mismatched source metadata '${batch.source.id}@${batch.source.version}'.`,
    );
  }
  store.add(provider.factKind, batch);
}

function languageFor(file: string): "typescript" | "javascript" {
  return /\.(?:jsx?|mjs|cjs)$/i.test(file) ? "javascript" : "typescript";
}

function linesIn(file: string, contents: ReadonlyMap<string, string>): number {
  const text = contents.get(file) ?? "";
  return text === "" ? 0 : text.split(/\r?\n/).length;
}

function sourceFileFacts(project: DiscoveredProject): SourceFile[] {
  return project.files
    .map((file) => {
      const relative = relativeToRoot(project.root, file);
      return {
        path: relative,
        language: languageFor(file),
        lines: linesIn(file, project.fileContents),
        provenance: {
          origin: "observed" as const,
          analyzer: "typescript-source",
          evidence: [{ kind: "file" as const, id: relative, file: relative }],
        },
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface ModuleInferenceFact {
  modules: readonly ArchitectureModule[];
  fileToModule: readonly (readonly [string, string])[];
  moduleEntrypoints: readonly (readonly [string, readonly string[]])[];
}

const sourceFileProvider: FactProvider<SourceFile> = {
  id: "typescript/source-files",
  version: TOOL_VERSION,
  factKind: "source.files",
  collect: ({ project }) => ({
    source: { id: sourceFileProvider.id, version: sourceFileProvider.version },
    facts: sourceFileFacts(project),
  }),
};

const importProvider: FactProvider<SourceImport> = {
  id: "typescript/imports",
  version: TOOL_VERSION,
  factKind: "source.imports",
  collect: ({ project, typeAware, sourceAstCache, resolutionCache }) => ({
    source: { id: importProvider.id, version: importProvider.version },
    facts: collectEdges(project, typeAware, sourceAstCache, resolutionCache),
  }),
};

const declarationProvider: FactProvider<ModuleDeclarationFact> = {
  id: "architecture/declarations",
  version: TOOL_VERSION,
  factKind: "architecture.declarations",
  collect: ({ project }) => {
    const declarations = collectModuleDeclarations(project);
    return {
      source: { id: declarationProvider.id, version: declarationProvider.version },
      facts: declarations,
    };
  },
};

export const BUILTIN_FACT_PROVIDERS = [declarationProvider, sourceFileProvider, importProvider] as const;

/** Collect facts from an explicit provider composition in a deterministic store. */
export function collectFacts(
  context: AnalysisContext,
  providers: readonly FactProvider<unknown>[] = BUILTIN_FACT_PROVIDERS,
): FactStore {
  const store = new FactStore();
  for (const provider of providers) collectProvider(store, provider, context);
  return store;
}

export interface ModuleGraphProjectionInput {
  modules: readonly ArchitectureModule[];
  imports: readonly SourceImport[];
  fileToModule: ReadonlyMap<string, string>;
  moduleEntrypoints: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ModuleInferenceProjectionInput {
  project: DiscoveredProject;
  declarations: readonly ModuleDeclarationFact[];
}

export const moduleInferenceProjector: Projector<ModuleInferenceProjectionInput, ModuleInferenceFact> = {
  id: "architecture/module-inference",
  version: TOOL_VERSION,
  project: ({ project, declarations }) => {
    const inferred = inferModulesWithDeclarations(project, declarations);
    const fileToModule = [...inferred.fileToModule.entries()]
      .map(([file, module]) => [relativeToRoot(project.root, file), module] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    const moduleEntrypoints = inferred.modules
      .map((module) => [module.id, [...module.entrypoints]] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    return {
      modules: Object.freeze([...inferred.modules]),
      fileToModule,
      moduleEntrypoints,
    };
  },
};

export interface DeclarativeArchitectureProjectionInput {
  modules: readonly ArchitectureModule[];
  declarations: readonly ModuleDeclarationFact[];
  moduleEdges: readonly ModuleEdge[];
  projectRoot?: string;
}

export const declarativeArchitectureProjector: Projector<
  DeclarativeArchitectureProjectionInput,
  DeclarativeArchitectureProjection
> = {
  id: "architecture/declarative-contracts",
  version: TOOL_VERSION,
  project: ({ modules, declarations, moduleEdges, projectRoot }) =>
    projectDeclarativeArchitecture(modules, declarations, moduleEdges, projectRoot),
};

export interface ModuleGraphProjection {
  moduleEdges: ModuleEdge[];
  cycles: ArchitectureCycle[];
}

export const moduleGraphProjector: Projector<ModuleGraphProjectionInput, ModuleGraphProjection> = {
  id: "architecture/module-graph",
  version: TOOL_VERSION,
  project: (input) => {
    const moduleEdges = buildModuleEdges(
      [...input.imports],
      new Map(input.fileToModule),
      new Map(
        [...input.moduleEntrypoints.entries()].map(([module, entrypoints]) => [module, new Set(entrypoints)] as const),
      ),
    );
    return {
      moduleEdges,
      cycles: findCycles([...input.modules], moduleEdges),
    };
  },
};

export interface OwnershipProjectionInput {
  files: readonly SourceFile[];
  fileToModule: ReadonlyMap<string, string>;
}

export const ownershipProjector: Projector<OwnershipProjectionInput, FileOwnership[]> = {
  id: "architecture/ownership",
  version: TOOL_VERSION,
  project: ({ files, fileToModule }) =>
    files.map((file) => ({
      file: file.path,
      module: fileToModule.get(file.path)!,
      provenance: {
        origin: "inferred" as const,
        analyzer: "module-inference",
        evidence: [{ kind: "file" as const, id: file.path, file: file.path }],
      },
    })),
};

export const BUILTIN_PROJECTORS = [
  moduleInferenceProjector,
  moduleGraphProjector,
  declarativeArchitectureProjector,
  ownershipProjector,
] as const;

function pipelineComponents(components: readonly { id: string; version: string }[]): PipelineComponent[] {
  return components.map(({ id, version }) => ({ id, version }));
}

export const BUILTIN_PIPELINE: PipelineManifest = {
  providers: pipelineComponents(BUILTIN_FACT_PROVIDERS),
  projectors: pipelineComponents(BUILTIN_PROJECTORS),
};

export function clonePipelineManifest(manifest: PipelineManifest): PipelineManifest {
  return {
    providers: manifest.providers.map(({ id, version }) => ({ id, version })),
    projectors: manifest.projectors.map(({ id, version }) => ({ id, version })),
  };
}

export function hashPipeline(manifest: PipelineManifest): string {
  return sha256(manifest);
}
