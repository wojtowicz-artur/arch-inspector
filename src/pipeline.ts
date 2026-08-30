import type { ModuleResolutionCache, SourceAstCache } from "./imports.js";
import { collectEdges } from "./imports.js";
import {
  TOOL_VERSION,
  type ArchitectureCycle,
  type ArchitectureModule,
  type FileOwnership,
  type ModuleEdge,
  type SourceFile,
  type SourceImport,
} from "./ir.js";
import { buildModuleEdges, findCycles } from "./graph.js";
import { inferModules } from "./modules.js";
import { relativeToRoot, type DiscoveredProject } from "./project.js";
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

/**
 * Internal normalized fact store. Batches are append-only and kept ordered by
 * provider identity so future providers cannot silently replace one another.
 */
export class FactStore {
  private readonly batchesByKind = new Map<string, FactBatch<unknown>[]>();

  add<TFact>(factKind: string, batch: FactBatch<TFact>): void {
    if (factKind.trim() === "") throw new Error("Fact kind must not be empty.");
    if (batch.source.id.trim() === "" || batch.source.version.trim() === "") {
      throw new Error(`Fact batch '${factKind}' must declare a source id and version.`);
    }

    const current = this.batchesByKind.get(factKind) ?? [];
    if (current.some((entry) => entry.source.id === batch.source.id && entry.source.version === batch.source.version)) {
      throw new Error(
        `Fact provider '${batch.source.id}@${batch.source.version}' already supplied '${factKind}' facts.`,
      );
    }

    const stored: FactBatch<TFact> = {
      source: { ...batch.source },
      facts: Object.freeze([...batch.facts]),
    };
    const next = [...current, stored].sort(
      (left, right) =>
        left.source.id.localeCompare(right.source.id) || left.source.version.localeCompare(right.source.version),
    );
    this.batchesByKind.set(factKind, next);
  }

  batches<TFact>(factKind: string): readonly FactBatch<TFact>[] {
    return (this.batchesByKind.get(factKind) ?? []) as readonly FactBatch<TFact>[];
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
  fileToModule: ReadonlyMap<string, string>;
  moduleEntrypoints: ReadonlyMap<string, ReadonlySet<string>>;
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

const moduleProvider: FactProvider<ModuleInferenceFact> = {
  id: "architecture/module-inference",
  version: TOOL_VERSION,
  factKind: "architecture.module-inference",
  collect: ({ project }) => {
    const inferred = inferModules(project);
    const fileToModule = new Map(
      [...inferred.fileToModule.entries()].map(([file, module]) => [relativeToRoot(project.root, file), module]),
    );
    const moduleEntrypoints = new Map(
      inferred.modules.map((module) => [module.id, new Set(module.entrypoints)] as const),
    );
    return {
      source: { id: moduleProvider.id, version: moduleProvider.version },
      facts: [
        {
          modules: Object.freeze([...inferred.modules]),
          fileToModule,
          moduleEntrypoints,
        },
      ],
    };
  },
};

/** Collect the built-in source and architecture facts in a deterministic order. */
export function collectBuiltInFacts(context: AnalysisContext): FactStore {
  const store = new FactStore();
  collectProvider(store, moduleProvider, context);
  collectProvider(store, sourceFileProvider, context);
  collectProvider(store, importProvider, context);
  return store;
}

export interface ModuleGraphProjectionInput {
  modules: readonly ArchitectureModule[];
  imports: readonly SourceImport[];
  fileToModule: ReadonlyMap<string, string>;
  moduleEntrypoints: ReadonlyMap<string, ReadonlySet<string>>;
}

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
