import { IR_VERSION, LEGACY_IR_VERSION, TOOL_VERSION, type ArchitectureSnapshot } from "./ir.js";
import { architectureSnapshotSchema, legacyArchitectureSnapshotSchema } from "./ir-schema.js";
import { formatSchemaIssues } from "./schema-utils.js";
import { sha256 } from "./stable.js";
import { z } from "zod";

export class ArchitectureIRValidationError extends Error {
  readonly code = "INVALID_ARCHITECTURE_IR" as const;

  constructor(
    readonly issues: readonly string[],
    context = "Architecture snapshot",
  ) {
    super(`${context} is not an Architecture IR ${IR_VERSION} snapshot. ${issues.join("; ")}`);
    this.name = "ArchitectureIRValidationError";
  }
}

export class SnapshotReceiptError extends Error {
  readonly code = "INVALID_SNAPSHOT_RECEIPT" as const;

  constructor(context = "Architecture snapshot") {
    super(`${context} has an invalid snapshot receipt.`);
    this.name = "SnapshotReceiptError";
  }
}

/** Validate the runtime shape of the versioned IR without mutating the value. */
export function validateArchitectureSnapshot(value: unknown, context = "Architecture snapshot"): ArchitectureSnapshot {
  const validated = architectureSnapshotSchema.safeParse(value);
  if (!validated.success) {
    throw new ArchitectureIRValidationError([formatSchemaIssues(validated.error)], context);
  }
  return validated.data;
}

/** Verify the receipt after shape validation has succeeded. */
export function verifySnapshotReceipt(snapshot: ArchitectureSnapshot, context = "Architecture snapshot"): void {
  const { receipt, ...base } = snapshot;
  const expected = sha256({ ...base, receipt: { ...receipt, snapshotId: "" } });
  if (expected !== receipt.snapshotId) throw new SnapshotReceiptError(context);
}

/** Validate both the IR shape and the deterministic receipt. */
export function assertArchitectureSnapshot(value: unknown, context = "Architecture snapshot"): ArchitectureSnapshot {
  const snapshot = validateArchitectureSnapshot(value, context);
  verifySnapshotReceipt(snapshot, context);
  return snapshot;
}

function verifyLegacySnapshotReceipt(
  snapshot: z.infer<typeof legacyArchitectureSnapshotSchema>,
  context: string,
): void {
  const { receipt, ...base } = snapshot;
  const expected = sha256({ ...base, receipt: { ...receipt, snapshotId: "" } });
  if (expected !== receipt.snapshotId) throw new SnapshotReceiptError(`${context} (IR ${LEGACY_IR_VERSION})`);
}

/**
 * Migrate a verified Architecture IR 0.3 snapshot to the current contract.
 * The old receipt is checked before any fields are added so a persisted
 * snapshot cannot be silently upgraded after it was tampered with.
 */
export function migrateArchitectureSnapshot(value: unknown, context = "Architecture snapshot"): ArchitectureSnapshot {
  const validated = legacyArchitectureSnapshotSchema.safeParse(value);
  if (!validated.success) {
    throw new ArchitectureIRValidationError(
      [formatSchemaIssues(validated.error)],
      `${context} (IR ${LEGACY_IR_VERSION})`,
    );
  }
  verifyLegacySnapshotReceipt(validated.data, context);

  const { receipt: legacyReceipt, ...legacyBase } = validated.data;
  const base: Omit<ArchitectureSnapshot, "receipt"> = {
    ...legacyBase,
    irVersion: IR_VERSION,
    architecture: {
      ...legacyBase.architecture,
      moduleEdges: legacyBase.architecture.moduleEdges.map((edge) => ({
        ...edge,
        unknownImports: 0,
      })),
    },
    analysis: {
      ...legacyBase.analysis,
      metrics: {
        ...legacyBase.analysis.metrics,
        unknownVisibilityImports: 0,
      },
    },
  };
  const receiptBase = {
    tool: "arch-inspector" as const,
    toolVersion: TOOL_VERSION,
    irVersion: IR_VERSION,
    configHash: legacyReceipt.configHash,
    compilerOptionsHash: legacyReceipt.compilerOptionsHash,
    inputHash: legacyReceipt.inputHash,
  };
  return assertArchitectureSnapshot(
    {
      ...base,
      receipt: {
        ...receiptBase,
        snapshotId: sha256({ ...base, receipt: { ...receiptBase, snapshotId: "" } }),
      },
    },
    `${context} migrated from IR ${LEGACY_IR_VERSION}`,
  );
}
