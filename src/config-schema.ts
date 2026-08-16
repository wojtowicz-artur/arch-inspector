import { z } from "zod";
import { rulePackSchema, ruleSpecSchema } from "./rule-schema.js";

const moduleDeclarationSchema = z
  .object({
    root: z.string().min(1),
    publicEntrypoints: z.array(z.string()).optional(),
  })
  .strict();

const forbiddenDependencySchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    message: z.string().optional(),
  })
  .strict();

/** Runtime contract for the optional arch.config.json file. */
export const inspectorConfigSchema = z
  .object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    moduleRoots: z.array(z.string()).optional(),
    modules: z.record(z.string(), moduleDeclarationSchema).optional(),
    publicEntrypoints: z.record(z.string(), z.array(z.string())).optional(),
    noCycles: z.boolean().optional(),
    noDeepImports: z.boolean().optional(),
    failOn: z.array(z.string()).optional(),
    forbiddenDependencies: z.array(forbiddenDependencySchema).optional(),
    rules: z.array(ruleSpecSchema).optional(),
    rulePacks: z.array(rulePackSchema).optional(),
  })
  .strict();

export type InspectorConfig = z.infer<typeof inspectorConfigSchema>;
