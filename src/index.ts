/**
 * Public library API.
 *
 * The CLI is built on top of these functions, so consumers can integrate the
 * inspector into CI, editor tooling or another Node.js application without
 * invoking a child process.
 */
export { analyzeProject } from "./analyzer.js";
export { analyzeGitRef } from "./git.js";
export { diffSnapshots, loadSnapshot } from "./diff.js";
export { renderModuleGraphDot } from "./graph.js";
export { IR_VERSION } from "./ir.js";

export type {
  ArchitectureDiagnostic,
  ArchitectureCycle,
  ArchitectureFacts,
  ArchitectureEdge,
  ArchitectureFile,
  ArchitectureMetrics,
  ArchitectureModule,
  ArchitectureSnapshot,
  DiagnosticCategory,
  DiagnosticLevel,
  FactOrigin,
  ImportKind,
  ModuleEdge,
  Provenance,
  Resolution,
  SourceFacts,
} from "./ir.js";

export type { ArchitectureDiff, CollectionDiff, MetricDelta } from "./diff.js";
