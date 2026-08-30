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
export { createSarifLog, renderSarif } from "./sarif.js";
export {
  ArchitectureIRValidationError,
  assertArchitectureSnapshot,
  SnapshotReceiptError,
  validateArchitectureSnapshot,
  verifySnapshotReceipt,
} from "./ir-contract.js";
export { IR_CONTRACT, IR_VERSION, TOOL_VERSION } from "./ir.js";
export { architectureSnapshotSchema } from "./ir-schema.js";
export { boundaryZoneSchema, inspectorConfigSchema, moduleIdStrategySchema } from "./config-schema.js";
export type { BoundaryZone } from "./config-schema.js";
export { BUILTIN_RULE_PACK, BUILTIN_RULES, createRuleContext, createRuleRegistry, evaluateRules } from "./rules.js";
export {
  ruleFlagSchema,
  rulePackListSchema,
  rulePackSchema,
  ruleSpecListSchema,
  ruleSpecSchema,
  ruleSourceSchema,
} from "./rule-schema.js";

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
  ImportedSymbolKind,
  ModuleEdge,
  Provenance,
  Resolution,
  ResolutionConfidence,
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
  RuleRegistry,
  RuleSpec,
  RuleValue,
} from "./rules.js";
export type { RuleFlag, RulePack, RuleSource } from "./rule-schema.js";
export type { InspectorConfig, ModuleIdStrategy } from "./project.js";
export { buildTypeAwareImportIndex } from "./type-aware.js";
export type { TypeAwareImportIndex, TypeAwareImportInfo, TypeAwareImportSymbol } from "./type-aware.js";
