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

export const boundaryZoneSchema = z
  .object({
    /** Module IDs (or glob-like selectors) to which this zone applies. */
    from: z.array(z.string().min(1)).min(1),
    /** If present, every cross-zone target must match at least one selector. */
    allow: z.array(z.string().min(1)).optional(),
    /** Explicitly denied targets take precedence over allow selectors. */
    deny: z.array(z.string().min(1)).optional(),
    message: z.string().optional(),
  })
  .strict();

export type BoundaryZone = z.infer<typeof boundaryZoneSchema>;

export const moduleIdStrategySchema = z.enum(["compact", "relative-path"]);
export type ModuleIdStrategy = z.infer<typeof moduleIdStrategySchema>;

/** Runtime contract for the optional arch.config.json file. */
export const inspectorConfigSchema = z
  .object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    moduleRoots: z.array(z.string()).optional(),
    moduleIdStrategy: moduleIdStrategySchema.optional(),
    /** Opt in to TypeScript checker metadata for static imports. */
    typeAware: z.boolean().optional(),
    modules: z.record(z.string(), moduleDeclarationSchema).optional(),
    publicEntrypoints: z.record(z.string(), z.array(z.string())).optional(),
    noCycles: z.boolean().optional(),
    noDeepImports: z.boolean().optional(),
    failOn: z.array(z.string()).optional(),
    forbiddenDependencies: z.array(forbiddenDependencySchema).optional(),
    boundaryZones: z.record(z.string().min(1), boundaryZoneSchema).optional(),
    rules: z.array(ruleSpecSchema).optional(),
    rulePacks: z.array(rulePackSchema).optional(),
  })
  .strict();

export type InspectorConfig = z.infer<typeof inspectorConfigSchema>;
