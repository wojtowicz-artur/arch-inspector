import type {
  ArchitectureCycle,
  ArchitectureFinding,
  ArchitectureModule,
  DiagnosticCategory,
  DiagnosticLevel,
  EvidenceRef,
  SourceImport,
} from "./ir.js";
import type { BoundaryZone, InspectorConfig } from "./project.js";
import { formatSchemaIssues } from "./schema-utils.js";
import {
  rulePackListSchema,
  ruleSpecListSchema,
  type RuleFlag,
  type RulePack,
  type RuleSource,
} from "./rule-schema.js";
import { validateRuleSemantics } from "./rule-validation.js";
import { compare } from "./stable.js";

/** A normalized fact collection which can be consumed by a rule specification. */
export interface RuleRecord {
  data: Readonly<Record<string, unknown>>;
  derivedFrom?: readonly string[];
  evidence?: readonly EvidenceRef[];
}

export interface RuleContext {
  /** Feature flags are populated from project policy, not interpreted by individual rules. */
  flags: Readonly<Record<RuleFlag, boolean>>;
  collections: Readonly<Record<RuleSource, readonly RuleRecord[]>>;
}

export interface RuleInput {
  config: InspectorConfig;
  modules: ArchitectureModule[];
  imports: SourceImport[];
  fileToModule: Map<string, string>;
  moduleEntrypoints: Map<string, Set<string>>;
  cycles: ArchitectureCycle[];
}

export interface RuleFieldRef {
  field: string;
}

export type RuleValue = string | number | boolean | null | RuleFieldRef;

export type RuleOperator = "eq" | "neq" | "truthy" | "falsy" | "startsWith" | "includes" | "gt" | "gte" | "lt" | "lte";

export interface RuleCondition {
  field: string;
  operator: RuleOperator;
  value?: RuleValue;
}

export interface RuleFindingTemplate {
  category: DiagnosticCategory;
  level: DiagnosticLevel;
  message: string;
  file?: RuleFieldRef;
  line?: RuleFieldRef;
  related?: RuleFieldRef;
  data?: Readonly<Record<string, RuleFieldRef>>;
}

/**
 * Declarative rule definition. A rule selects one normalized collection, filters
 * records with data-only predicates and maps a matching record to a finding.
 */
export interface RuleSpec {
  code: string;
  source: RuleSource;
  enabledBy?: RuleFlag;
  where?: RuleCondition[];
  finding: RuleFindingTemplate;
}

export interface RuleRegistry {
  packs: readonly RulePack[];
  rules: readonly RuleSpec[];
  requiredFacts: readonly RuleSource[];
}

const field = (name: string): RuleFieldRef => ({ field: name });

/** Built-in policy is data; the evaluator below does not branch on rule codes. */
export const BUILTIN_RULES: readonly RuleSpec[] = [
  {
    code: "architecture/cycle",
    source: "cycles",
    enabledBy: "noCycles",
    finding: {
      category: "violation",
      level: "error",
      message: "Module dependency strongly-connected component: ${modules}.",
      related: field("modules"),
      data: { modules: field("modules"), edgeIds: field("edgeIds") },
    },
  },
  {
    code: "architecture/unresolved-import",
    source: "imports",
    where: [{ field: "isUnresolvedInternal", operator: "eq", value: true }],
    finding: {
      category: "observation",
      level: "warning",
      message: "Could not resolve internal import '${specifier}'.",
      file: field("fromFile"),
      line: field("line"),
      data: { specifier: field("specifier") },
    },
  },
  {
    code: "architecture/out-of-scope-import",
    source: "imports",
    where: [{ field: "isOutOfScope", operator: "eq", value: true }],
    finding: {
      category: "observation",
      level: "warning",
      message: "Internal import '${specifier}' resolves outside the analysis scope.",
      file: field("fromFile"),
      line: field("line"),
      data: { specifier: field("specifier"), target: field("target") },
    },
  },
  {
    code: "architecture/dynamic-import-ambiguous",
    source: "imports",
    where: [
      { field: "isDynamic", operator: "eq", value: true },
      { field: "resolutionConfidence", operator: "eq", value: "ambiguous" },
    ],
    finding: {
      category: "observation",
      level: "warning",
      message: "Dynamic dependency '${specifier}' could not be resolved statically.",
      file: field("fromFile"),
      line: field("line"),
      data: { specifier: field("specifier"), importKind: field("importKind") },
    },
  },
  {
    code: "architecture/boundary-violation",
    source: "imports",
    where: [{ field: "isBoundaryViolation", operator: "eq", value: true }],
    finding: {
      category: "violation",
      level: "error",
      message: "${boundaryMessage}",
      file: field("fromFile"),
      line: field("line"),
      related: field("toModule"),
      data: {
        from: field("fromModule"),
        to: field("toModule"),
        boundaryZone: field("boundaryZone"),
        specifier: field("specifier"),
        message: field("boundaryMessage"),
      },
    },
  },
  {
    code: "architecture/deep-import",
    source: "imports",
    enabledBy: "noDeepImports",
    where: [
      { field: "isInternal", operator: "eq", value: true },
      { field: "isCrossModule", operator: "eq", value: true },
      { field: "isPublicApi", operator: "eq", value: false },
    ],
    finding: {
      category: "violation",
      level: "warning",
      message: "${fromModule} imports ${target} instead of ${toModule}'s public entrypoint.",
      file: field("fromFile"),
      line: field("line"),
      data: { from: field("fromModule"), to: field("toModule"), target: field("target") },
    },
  },
  {
    code: "architecture/forbidden-dependency",
    source: "forbiddenDependencies",
    enabledBy: "forbiddenDependencies",
    finding: {
      category: "violation",
      level: "error",
      message: "${forbiddenMessage}",
      file: field("fromFile"),
      line: field("line"),
      data: { from: field("fromModule"), to: field("toModule") },
    },
  },
  {
    code: "architecture/no-public-entrypoint",
    source: "modules",
    where: [
      { field: "hasPublicEntrypoint", operator: "eq", value: false },
      { field: "hasPeers", operator: "eq", value: true },
    ],
    finding: {
      category: "observation",
      level: "info",
      message: "Module '${moduleId}' has no index entrypoint; cross-module imports cannot be checked as public API.",
      related: field("related"),
    },
  },
];

export const BUILTIN_RULE_PACK: RulePack = {
  id: "arch-inspector/core",
  version: "0.3.0",
  requiredFacts: ["cycles", "imports", "forbiddenDependencies", "modules"],
  rules: [...BUILTIN_RULES],
};

function requiredFactsFor(rules: readonly RuleSpec[]): RuleSource[] {
  return [...new Set(rules.map((rule) => rule.source))].sort();
}

/** Create a deterministic registry and reject ambiguous or incomplete packs. */
export function createRuleRegistry(packs: readonly RulePack[]): RuleRegistry {
  const validated = rulePackListSchema.safeParse(packs);
  if (!validated.success) throw new Error(`Invalid rule pack: ${formatSchemaIssues(validated.error)}`);

  const sortedPacks = [...validated.data].sort(
    (left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version),
  );
  const seenPackIds = new Set<string>();
  const seenRuleCodes = new Set<string>();
  const rules: RuleSpec[] = [];
  const requiredFacts = new Set<RuleSource>();

  for (const pack of sortedPacks) {
    if (seenPackIds.has(pack.id)) throw new Error(`Duplicate rule pack id: ${pack.id}`);
    seenPackIds.add(pack.id);
    const declaredFacts = new Set(pack.requiredFacts);
    for (const rule of pack.rules) {
      validateRuleSemantics(rule);
      if (!declaredFacts.has(rule.source)) {
        throw new Error(`Rule pack '${pack.id}' does not declare required fact '${rule.source}'.`);
      }
      if (seenRuleCodes.has(rule.code)) throw new Error(`Duplicate rule code: ${rule.code}`);
      seenRuleCodes.add(rule.code);
      rules.push(rule);
    }
    for (const fact of pack.requiredFacts) requiredFacts.add(fact);
  }

  return {
    packs: sortedPacks,
    rules,
    requiredFacts: [...requiredFacts].sort(),
  };
}

function configuredRulePacks(config: InspectorConfig): RulePack[] {
  const packs: RulePack[] = [BUILTIN_RULE_PACK];
  if (config.rules?.length) {
    packs.push({
      id: "project/rules",
      version: "config",
      requiredFacts: requiredFactsFor(config.rules),
      rules: [...config.rules],
    });
  }
  packs.push(...(config.rulePacks ?? []));
  return packs;
}

function inlineRulePack(specs: readonly RuleSpec[]): RulePack {
  return {
    id: "runtime/inline",
    version: "runtime",
    requiredFacts: requiredFactsFor(specs),
    rules: [...specs],
  };
}

function isRuleRegistry(selection: RuleRegistry | readonly RuleSpec[]): selection is RuleRegistry {
  return !Array.isArray(selection);
}

const levelRank = { error: 0, warning: 1, info: 2 } as const;

function evidenceForEdge(edge: SourceImport): EvidenceRef[] {
  return [{ kind: "source-edge", id: edge.id, file: edge.fromFile, line: edge.location.line }];
}

function isRelativeLike(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#");
}

function selectorRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function matchesSelector(value: string, selector: string): boolean {
  return selectorRegExp(selector.replaceAll("\\", "/")).test(value.replaceAll("\\", "/"));
}

function moduleSelectors(module: ArchitectureModule | undefined): string[] {
  if (!module) return [];
  return [module.id, module.stableId, module.root].filter((value): value is string => Boolean(value));
}

function selectorMatchesModule(module: ArchitectureModule | undefined, selector: string): boolean {
  return moduleSelectors(module).some((value) => matchesSelector(value, selector));
}

function boundaryViolation(
  fromModule: ArchitectureModule | undefined,
  toModule: ArchitectureModule | undefined,
  zones: Readonly<Record<string, BoundaryZone>> | undefined,
): { id: string; message?: string } | undefined {
  if (!fromModule || !toModule || fromModule.id === toModule.id || !zones) return undefined;
  for (const [id, zone] of Object.entries(zones).sort(([left], [right]) => compare(left, right))) {
    if (!zone.from.some((selector) => selectorMatchesModule(fromModule, selector))) continue;
    const denied = zone.deny?.some((selector) => selectorMatchesModule(toModule, selector)) === true;
    const allowed = zone.allow ? zone.allow.some((selector) => selectorMatchesModule(toModule, selector)) : true;
    if (denied || !allowed) return { id, ...(zone.message ? { message: zone.message } : {}) };
  }
  return undefined;
}

function cycleRecords(cycles: ArchitectureCycle[]): RuleRecord[] {
  return cycles.map((cycle) => ({
    data: { id: cycle.id, modules: cycle.modules, edgeIds: cycle.edgeIds },
    derivedFrom: cycle.edgeIds,
    evidence: cycle.edgeIds.map((id) => ({ kind: "module-edge" as const, id })),
  }));
}

function importRecords(input: RuleInput): RuleRecord[] {
  const modulesById = new Map(input.modules.map((module) => [module.id, module]));
  return input.imports.map((edge) => {
    const fromModule = input.fileToModule.get(edge.fromFile);
    const toModule = edge.toFile ? input.fileToModule.get(edge.toFile) : undefined;
    const isInternal = edge.resolution === "internal";
    const isCrossModule = Boolean(fromModule && toModule && fromModule !== toModule);
    const isPublicApi = toModule ? input.moduleEntrypoints.get(toModule)?.has(edge.toFile ?? "") === true : false;
    const boundary = boundaryViolation(
      modulesById.get(fromModule ?? ""),
      modulesById.get(toModule ?? ""),
      input.config.boundaryZones,
    );
    const boundaryMessage = boundary
      ? (boundary.message ?? `${fromModule} is not allowed to depend on ${toModule} in boundary zone '${boundary.id}'.`)
      : undefined;
    return {
      data: {
        id: edge.id,
        fromFile: edge.fromFile,
        toFile: edge.toFile,
        specifier: edge.specifier,
        line: edge.location.line,
        resolution: edge.resolution,
        resolutionConfidence: edge.resolutionConfidence,
        isProjectAlias: edge.isProjectAlias === true,
        importKind: edge.importKind,
        typeOnly: edge.typeOnly,
        symbols: edge.symbols?.map((symbol) => symbol.name),
        symbolKinds: edge.symbols?.map((symbol) => symbol.kind),
        fromModule,
        toModule,
        target: edge.toFile ?? edge.specifier,
        isInternal,
        isCrossModule,
        isPublicApi,
        isUnresolvedInternal:
          edge.resolution === "unresolved" && (isRelativeLike(edge.specifier) || edge.isProjectAlias === true),
        isOutOfScope: edge.resolution === "out-of-scope",
        isDynamic: edge.importKind === "dynamic" || edge.importKind === "require",
        isBoundaryViolation: boundary !== undefined,
        boundaryZone: boundary?.id,
        boundaryMessage,
      },
      derivedFrom: [edge.id],
      evidence: evidenceForEdge(edge),
    };
  });
}

function forbiddenDependencyRecords(input: RuleInput, imports: readonly RuleRecord[]): RuleRecord[] {
  const rules = input.config.forbiddenDependencies ?? [];
  return imports.flatMap((record) => {
    const fromModule = record.data.fromModule;
    const toModule = record.data.toModule;
    if (record.data.isInternal !== true || typeof fromModule !== "string" || typeof toModule !== "string") return [];
    const matchingRules = rules.filter((rule) => rule.from === fromModule && rule.to === toModule);
    return matchingRules.map((rule, index) => ({
      ...record,
      // A single source edge may match several policy entries. Keep those
      // findings distinct even when their rendered messages happen to agree.
      derivedFrom: [...(record.derivedFrom ?? []), `forbidden-dependency-rule:${index}`],
      data: {
        ...record.data,
        forbiddenMessage: renderMessage(
          rule.message ?? `${String(fromModule)} is not allowed to depend on ${String(toModule)}.`,
          record,
        ),
      },
    }));
  });
}

function moduleRecords(modules: ArchitectureModule[]): RuleRecord[] {
  return modules.map((module) => ({
    data: {
      moduleId: module.id,
      hasPublicEntrypoint: module.entrypoints.length > 0,
      hasPeers: modules.length > 1,
      related: [module.id],
    },
    evidence: [{ kind: "module" as const, id: module.stableId ?? module.root ?? module.id }],
  }));
}

/** Project source and architecture facts into collections shared by all rules. */
export function createRuleContext(input: RuleInput): RuleContext {
  const imports = importRecords(input);
  return {
    flags: {
      noCycles: input.config.noCycles ?? true,
      noDeepImports: input.config.noDeepImports ?? true,
      forbiddenDependencies: (input.config.forbiddenDependencies?.length ?? 0) > 0,
    },
    collections: {
      cycles: cycleRecords(input.cycles),
      imports,
      forbiddenDependencies: forbiddenDependencyRecords(input, imports),
      modules: moduleRecords(input.modules),
    },
  };
}

function isFieldRef(value: RuleValue | undefined): value is RuleFieldRef {
  return typeof value === "object" && value !== null && "field" in value;
}

function valueOf(record: RuleRecord, value: RuleValue | undefined): unknown {
  if (value === undefined) return undefined;
  return isFieldRef(value) ? record.data[value.field] : value;
}

function matchesCondition(record: RuleRecord, condition: RuleCondition): boolean {
  const actual = record.data[condition.field];
  const expected = valueOf(record, condition.value);
  switch (condition.operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    case "startsWith":
      return typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected);
    case "includes":
      return Array.isArray(actual)
        ? actual.includes(expected)
        : typeof actual === "string" && actual.includes(String(expected));
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
  }
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null) return "";
  return String(value);
}

function renderMessage(template: string, record: RuleRecord): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, name: string) => formatValue(record.data[name]));
}

function emitFinding(rule: RuleSpec, record: RuleRecord): ArchitectureFinding {
  const file = rule.finding.file ? record.data[rule.finding.file.field] : undefined;
  const line = rule.finding.line ? record.data[rule.finding.line.field] : undefined;
  const relatedValue = rule.finding.related ? record.data[rule.finding.related.field] : undefined;
  const related = Array.isArray(relatedValue)
    ? relatedValue.filter((value): value is string => typeof value === "string")
    : typeof relatedValue === "string"
      ? [relatedValue]
      : undefined;
  const data = rule.finding.data
    ? Object.fromEntries(
        Object.entries(rule.finding.data)
          .map(([key, reference]) => [key, record.data[reference.field]] as const)
          .filter(([, value]) => value !== undefined),
      )
    : undefined;
  return {
    code: rule.code,
    category: rule.finding.category,
    level: rule.finding.level,
    message: renderMessage(rule.finding.message, record),
    ...(typeof file === "string" ? { file } : {}),
    ...(typeof line === "number" ? { line } : {}),
    ...(related ? { related } : {}),
    ...(data ? { data } : {}),
    provenance: {
      origin: "derived",
      analyzer: "architecture-rules",
      rule: rule.code,
      ...(record.derivedFrom?.length ? { derivedFrom: [...record.derivedFrom] } : {}),
      ...(record.evidence?.length ? { evidence: [...record.evidence] } : {}),
    },
  };
}

/** Evaluate data-only rule specifications against normalized architecture facts. */
export function evaluateRules(input: RuleInput, selection?: RuleRegistry | readonly RuleSpec[]): ArchitectureFinding[] {
  let registry: RuleRegistry;
  if (!selection) {
    registry = createRuleRegistry(configuredRulePacks(input.config));
  } else if (Array.isArray(selection)) {
    const validated = ruleSpecListSchema.safeParse(selection);
    if (!validated.success) {
      throw new Error(`Invalid rule specification: ${formatSchemaIssues(validated.error)}`);
    }
    registry = createRuleRegistry([inlineRulePack(validated.data)]);
  } else if (isRuleRegistry(selection)) {
    registry = createRuleRegistry(selection.packs);
  } else {
    throw new Error("Invalid rule selection.");
  }
  const context = createRuleContext(input);
  const missingFacts = registry.requiredFacts.filter((fact) => !(fact in context.collections));
  if (missingFacts.length > 0) throw new Error(`Rule registry requires unavailable facts: ${missingFacts.join(", ")}.`);
  const findings = registry.rules.flatMap((rule) => {
    if (rule.enabledBy && context.flags[rule.enabledBy] !== true) return [];
    const records = context.collections[rule.source] ?? [];
    return records
      .filter((record) => (rule.where ?? []).every((condition) => matchesCondition(record, condition)))
      .map((record) => emitFinding(rule, record));
  });
  return findings.sort(
    (a, b) =>
      levelRank[a.level] - levelRank[b.level] ||
      compare(a.code, b.code) ||
      compare(a.file ?? "", b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      compare(a.message, b.message),
  );
}

export { findingKey } from "./finding-identity.js";

export { matchesFailOn } from "./fail-on.js";
