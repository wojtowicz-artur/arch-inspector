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

export const ruleSpecSchema = z
  .object({
    code: z.string().min(1),
    source: ruleSourceSchema,
    enabledBy: ruleFlagSchema.optional(),
    where: z.array(ruleConditionSchema).optional(),
    finding: ruleFindingTemplateSchema,
  })
  .strict();

export const ruleSpecListSchema = z.array(ruleSpecSchema);
