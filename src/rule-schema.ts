import { z } from "zod";

const ruleFieldRefSchema = z.object({ field: z.string().min(1) }).strict();

export const ruleSourceSchema = z.enum(["cycles", "imports", "forbiddenDependencies", "modules"]);
export type RuleSource = z.infer<typeof ruleSourceSchema>;

export const ruleFlagSchema = z.enum(["noCycles", "noDeepImports", "forbiddenDependencies"]);
export type RuleFlag = z.infer<typeof ruleFlagSchema>;

const ruleValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), ruleFieldRefSchema]);

const ruleOperatorSchema = z.enum(["eq", "neq", "truthy", "falsy", "startsWith", "includes", "gt", "gte", "lt", "lte"]);

const ruleConditionSchema = z
  .object({
    field: z.string().min(1),
    operator: ruleOperatorSchema,
    value: ruleValueSchema.optional(),
  })
  .strict();

const ruleFindingTemplateSchema = z
  .object({
    category: z.enum(["violation", "observation"]),
    level: z.enum(["error", "warning", "info"]),
    message: z.string(),
    file: ruleFieldRefSchema.optional(),
    line: ruleFieldRefSchema.optional(),
    related: ruleFieldRefSchema.optional(),
    data: z.record(z.string(), ruleFieldRefSchema).optional(),
  })
  .strict();

export const ruleFieldsBySource: Readonly<Record<z.infer<typeof ruleSourceSchema>, readonly string[]>> = {
  cycles: ["id", "modules", "edgeIds"],
  imports: [
    "id",
    "fromFile",
    "toFile",
    "specifier",
    "line",
    "resolution",
    "resolutionConfidence",
    "isProjectAlias",
    "importKind",
    "typeOnly",
    "symbols",
    "symbolKinds",
    "isProjectLike",
    "fromModule",
    "toModule",
    "target",
    "isInternal",
    "isCrossModule",
    "isPublicApi",
    "publicApiStatus",
    "isUnresolvedInternal",
    "isOutOfScope",
    "isDynamic",
    "isBoundaryViolation",
    "boundaryZone",
    "boundaryMessage",
  ],
  forbiddenDependencies: [
    "id",
    "fromFile",
    "toFile",
    "specifier",
    "line",
    "resolution",
    "resolutionConfidence",
    "isProjectAlias",
    "importKind",
    "typeOnly",
    "symbols",
    "symbolKinds",
    "isProjectLike",
    "fromModule",
    "toModule",
    "target",
    "isInternal",
    "isCrossModule",
    "isPublicApi",
    "publicApiStatus",
    "isUnresolvedInternal",
    "isOutOfScope",
    "isDynamic",
    "isBoundaryViolation",
    "boundaryZone",
    "boundaryMessage",
    "forbiddenMessage",
  ],
  modules: ["moduleId", "hasPublicEntrypoint", "hasPeers", "related"],
};

function validateRuleFieldReference(
  source: z.infer<typeof ruleSourceSchema>,
  field: string,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  if (!ruleFieldsBySource[source].includes(field)) {
    context.addIssue({
      code: "custom",
      path,
      message: `Field '${field}' is not available for '${source}'.`,
    });
  }
}

export const ruleSpecSchema = z
  .object({
    code: z.string().min(1),
    source: ruleSourceSchema,
    enabledBy: ruleFlagSchema.optional(),
    where: z.array(ruleConditionSchema).optional(),
    finding: ruleFindingTemplateSchema,
  })
  .strict()
  .superRefine((rule, context) => {
    for (const [index, condition] of (rule.where ?? []).entries()) {
      validateRuleFieldReference(rule.source, condition.field, ["where", index, "field"], context);
      if (typeof condition.value === "object" && condition.value !== null && "field" in condition.value) {
        validateRuleFieldReference(rule.source, condition.value.field, ["where", index, "value", "field"], context);
      }
    }
    for (const [name, reference] of Object.entries({
      file: rule.finding.file,
      line: rule.finding.line,
      related: rule.finding.related,
    })) {
      if (reference) validateRuleFieldReference(rule.source, reference.field, ["finding", name, "field"], context);
    }
    for (const [name, reference] of Object.entries(rule.finding.data ?? {})) {
      validateRuleFieldReference(rule.source, reference.field, ["finding", "data", name, "field"], context);
    }
    for (const match of rule.finding.message.matchAll(/\$\{([^}]+)\}/g)) {
      validateRuleFieldReference(rule.source, match[1], ["finding", "message"], context);
    }
  });

export const ruleSpecListSchema = z.array(ruleSpecSchema);

export const rulePackSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    requiredFacts: z.array(ruleSourceSchema),
    rules: ruleSpecListSchema,
  })
  .strict();

export const rulePackListSchema = z.array(rulePackSchema);
export type RulePack = z.infer<typeof rulePackSchema>;
