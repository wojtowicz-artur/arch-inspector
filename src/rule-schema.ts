import { z } from "zod";

const ruleFieldRefSchema = z.object({ field: z.string().min(1) }).strict();

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
    source: z.string().min(1),
    enabledBy: z.string().min(1).optional(),
    where: z.array(ruleConditionSchema).optional(),
    finding: ruleFindingTemplateSchema,
  })
  .strict();

export const ruleSpecListSchema = z.array(ruleSpecSchema);
