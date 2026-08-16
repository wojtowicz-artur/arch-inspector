/**
 * Public library API.
 *
 * The CLI is built on top of these functions, so consumers can integrate the
 * inspector into CI, editor tooling or another Node.js application without
 * invoking a child process.
 */
export { analyzeProject } from "./analyzer.js";
export { analyzeGitRef } from "./git.js";
export { diffSnapshots, loadSnapshot, SnapshotComparisonError } from "./diff.js";
export { renderModuleGraphDot } from "./graph.js";
export { IR_VERSION, TOOL_VERSION } from "./ir.js";
export { architectureSnapshotSchema } from "./ir-schema.js";
export { inspectorConfigSchema } from "./config-schema.js";
export { BUILTIN_RULES, createRuleContext, evaluateRules } from "./rules.js";
export { ruleFlagSchema, ruleSpecListSchema, ruleSpecSchema, ruleSourceSchema } from "./rule-schema.js";

export type {
  AnalysisFacts,
  ArchitectureCycle,
  ArchitectureFinding,
  ArchitectureMetrics,
  ArchitectureModule,
  ArchitectureSnapshot,
  DiagnosticCategory,
  DiagnosticLevel,
  EvidenceKind,
  EvidenceRef,
  FactOrigin,
  FileOwnership,
  ImportKind,
  ModuleEdge,
  Provenance,
  Resolution,
  SnapshotPolicy,
  SnapshotReceipt,
  SourceFile,
  SourceFacts,
  SourceImport,
} from "./ir.js";

export type { ArchitectureDiff, CollectionDiff, MetricDelta } from "./diff.js";
export type {
  RuleCondition,
  RuleContext,
  RuleFieldRef,
  RuleFindingTemplate,
  RuleInput,
  RuleOperator,
  RuleRecord,
  RuleSpec,
  RuleValue,
} from "./rules.js";
export type { RuleFlag, RuleSource } from "./rule-schema.js";
export type { InspectorConfig } from "./project.js";
