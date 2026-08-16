import { z } from "zod";
import { IR_VERSION, TOOL_VERSION, type ArchitectureSnapshot } from "./ir.js";

const factOriginSchema = z.enum(["observed", "declared", "inferred", "derived"]);
const evidenceKindSchema = z.enum(["file", "source-edge", "module", "module-edge", "config", "rule"]);

const evidenceRefSchema = z
  .object({
    kind: evidenceKindSchema,
    id: z.string(),
    file: z.string().optional(),
    line: z.number().int().nonnegative().optional(),
  })
  .strict();

const provenanceSchema = z
  .object({
    origin: factOriginSchema,
    analyzer: z.string().optional(),
    rule: z.string().optional(),
    evidence: z.array(evidenceRefSchema).optional(),
    derivedFrom: z.array(z.string()).optional(),
  })
  .strict();

const sourceFileSchema = z
  .object({
    path: z.string(),
    language: z.enum(["typescript", "javascript"]),
    lines: z.number().int().nonnegative(),
    provenance: provenanceSchema,
  })
  .strict();

const sourceImportSchema = z
  .object({
    id: z.string(),
    fromFile: z.string(),
    toFile: z.string().optional(),
    specifier: z.string(),
    importKind: z.enum(["static", "export", "dynamic", "require"]),
    resolution: z.enum(["internal", "external", "asset", "unresolved"]),
    typeOnly: z.boolean(),
    location: z
      .object({
        line: z.number().int().positive(),
        column: z.number().int().nonnegative(),
      })
      .strict(),
    provenance: provenanceSchema,
  })
  .strict();

const architectureModuleSchema = z
  .object({
    id: z.string(),
    root: z.string(),
    files: z.array(z.string()),
    entrypoints: z.array(z.string()),
    provenance: provenanceSchema,
  })
  .strict();

const fileOwnershipSchema = z
  .object({
    file: z.string(),
    module: z.string(),
    provenance: provenanceSchema,
  })
  .strict();

const moduleEdgeSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    imports: z.number().int().nonnegative(),
    publicApiImports: z.number().int().nonnegative(),
    deepImports: z.number().int().nonnegative(),
    files: z.array(z.string()),
    sourceEdgeIds: z.array(z.string()),
    visibility: z.enum(["public", "deep", "mixed"]),
    provenance: provenanceSchema,
  })
  .strict();

const architectureCycleSchema = z
  .object({
    id: z.string(),
    modules: z.array(z.string()),
    edgeIds: z.array(z.string()),
    provenance: provenanceSchema,
  })
  .strict();

const architectureMetricsSchema = z
  .object({
    sourceFiles: z.number().int().nonnegative(),
    modules: z.number().int().nonnegative(),
    imports: z.number().int().nonnegative(),
    internalImports: z.number().int().nonnegative(),
    externalImports: z.number().int().nonnegative(),
    assetImports: z.number().int().nonnegative(),
    unresolvedImports: z.number().int().nonnegative(),
    moduleEdges: z.number().int().nonnegative(),
    cycles: z.number().int().nonnegative(),
    deepImports: z.number().int().nonnegative(),
    maxFanIn: z.object({ module: z.string(), value: z.number().int().nonnegative() }).strict().nullable(),
    maxFanOut: z.object({ module: z.string(), value: z.number().int().nonnegative() }).strict().nullable(),
    provenance: provenanceSchema,
  })
  .strict();

const architectureFindingSchema = z
  .object({
    code: z.string(),
    category: z.enum(["violation", "observation"]),
    level: z.enum(["error", "warning", "info"]),
    message: z.string(),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    related: z.array(z.string()).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    provenance: provenanceSchema,
  })
  .strict();

const snapshotReceiptSchema = z
  .object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    tool: z.literal("arch-inspector"),
    toolVersion: z.literal(TOOL_VERSION),
    irVersion: z.literal(IR_VERSION),
    configHash: z.string().regex(/^[a-f0-9]{64}$/),
    compilerOptionsHash: z.string().regex(/^[a-f0-9]{64}$/),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const architectureSnapshotSchema: z.ZodType<ArchitectureSnapshot> = z
  .object({
    irVersion: z.literal(IR_VERSION),
    receipt: snapshotReceiptSchema,
    project: z
      .object({
        root: z.string(),
        tsconfig: z.string(),
        sourceRoot: z.string(),
      })
      .strict(),
    policy: z
      .object({
        failOn: z.array(z.string()),
        provenance: provenanceSchema,
      })
      .strict(),
    source: z
      .object({
        files: z.array(sourceFileSchema),
        imports: z.array(sourceImportSchema),
        provenance: provenanceSchema,
      })
      .strict(),
    architecture: z
      .object({
        modules: z.array(architectureModuleSchema),
        ownership: z.array(fileOwnershipSchema),
        moduleEdges: z.array(moduleEdgeSchema),
        provenance: provenanceSchema,
      })
      .strict(),
    analysis: z
      .object({
        cycles: z.array(architectureCycleSchema),
        metrics: architectureMetricsSchema,
        findings: z.array(architectureFindingSchema),
        provenance: provenanceSchema,
      })
      .strict(),
  })
  .strict();

export { architectureSnapshotSchema };
