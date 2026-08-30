export const IR_VERSION = "0.4" as const;
export const TOOL_VERSION = "0.4.0" as const;
export const IR_CONTRACT = {
  version: IR_VERSION,
  compatibility: "exact",
  unknownFields: "reject",
  receipt: "required",
} as const;

export type Resolution = "internal" | "external" | "asset" | "unresolved" | "out-of-scope";
export type ResolutionConfidence = "exact" | "syntactic" | "ambiguous";
export type ImportKind = "static" | "export" | "dynamic" | "require";
export type ImportedSymbolKind = "type" | "value" | "both" | "unknown";
export type ModuleEdgeVisibility = "public" | "deep" | "unknown" | "mixed";
export type DiagnosticLevel = "error" | "warning" | "info";
export type DiagnosticCategory = "violation" | "observation";
export type FactOrigin = "observed" | "declared" | "inferred" | "derived";

export type EvidenceKind = "file" | "source-edge" | "module" | "module-edge" | "config" | "rule";

export interface EvidenceRef {
  kind: EvidenceKind;
  id: string;
  file?: string;
  line?: number;
}

export interface Provenance {
  origin: FactOrigin;
  analyzer?: string;
  rule?: string;
  evidence?: EvidenceRef[];
  derivedFrom?: string[];
}

export interface SnapshotReceipt {
  snapshotId: string;
  tool: "arch-inspector";
  /** Semver of the analyzer that produced this snapshot. */
  toolVersion: string;
  irVersion: typeof IR_VERSION;
  configHash: string;
  compilerOptionsHash: string;
  inputHash: string;
}

export interface SnapshotPolicy {
  failOn: string[];
  /** Rule codes known to the analyzer, including rules with zero matches. */
  knownRuleCodes?: string[];
  provenance: Provenance;
}

/** A fact emitted directly from the source tree and resolver. */
export interface SourceFile {
  path: string;
  language: "typescript" | "javascript";
  lines: number;
  provenance: Provenance;
}

/** A raw import edge. Module ownership and public API are architecture projections. */
export interface SourceImport {
  id: string;
  fromFile: string;
  toFile?: string;
  specifier: string;
  importKind: ImportKind;
  resolution: Resolution;
  /** Whether the resolver proved the target or the classification is heuristic. */
  resolutionConfidence?: ResolutionConfidence;
  /** Whether the specifier matched a compilerOptions.paths project alias. */
  isProjectAlias?: boolean;
  /** Whether the dependency looks like a project-owned package when resolution is incomplete. */
  isProjectLike?: boolean;
  typeOnly: boolean;
  /** Optional TypeScript checker evidence for statically imported exports. */
  symbols?: Array<{
    name: string;
    kind: ImportedSymbolKind;
  }>;
  location: {
    line: number;
    column: number;
  };
  provenance: Provenance;
}

export interface SourceFacts {
  files: SourceFile[];
  imports: SourceImport[];
  provenance: Provenance;
}

export interface ArchitectureModule {
  id: string;
  /** Stable identity derived from the module root; `id` remains the display/policy name. */
  stableId?: string;
  root: string;
  files: string[];
  entrypoints: string[];
  provenance: Provenance;
}

export interface FileOwnership {
  file: string;
  module: string;
  provenance: Provenance;
}

export interface ModuleEdge {
  id: string;
  from: string;
  to: string;
  imports: number;
  publicApiImports: number;
  deepImports: number;
  unknownImports: number;
  files: string[];
  sourceEdgeIds: string[];
  visibility: ModuleEdgeVisibility;
  provenance: Provenance;
}

export interface ArchitectureFacts {
  modules: ArchitectureModule[];
  ownership: FileOwnership[];
  moduleEdges: ModuleEdge[];
  provenance: Provenance;
}

export interface ArchitectureCycle {
  id: string;
  modules: string[];
  edgeIds: string[];
  provenance: Provenance;
}

export interface ArchitectureMetrics {
  sourceFiles: number;
  modules: number;
  imports: number;
  internalImports: number;
  externalImports: number;
  assetImports: number;
  unresolvedImports: number;
  /** Imports resolved to a local file excluded from the analysis scope. */
  outOfScopeImports?: number;
  moduleEdges: number;
  cycles: number;
  deepImports: number;
  /** Cross-module imports whose public visibility could not be proven. */
  unknownVisibilityImports: number;
  maxFanIn: { module: string; value: number } | null;
  maxFanOut: { module: string; value: number } | null;
  provenance: Provenance;
}

export interface ArchitectureFinding {
  code: string;
  category: DiagnosticCategory;
  level: DiagnosticLevel;
  message: string;
  file?: string;
  line?: number;
  related?: string[];
  data?: Record<string, unknown>;
  provenance: Provenance;
}

export interface AnalysisFacts {
  cycles: ArchitectureCycle[];
  metrics: ArchitectureMetrics;
  findings: ArchitectureFinding[];
  provenance: Provenance;
}

export interface ArchitectureSnapshot {
  irVersion: typeof IR_VERSION;
  receipt: SnapshotReceipt;
  project: {
    root: string;
    tsconfig: string;
    sourceRoot: string;
  };
  policy: SnapshotPolicy;
  source: SourceFacts;
  architecture: ArchitectureFacts;
  analysis: AnalysisFacts;
}
