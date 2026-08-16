import { IR_VERSION, type ArchitectureSnapshot } from "./ir.js";
import { architectureSnapshotSchema } from "./ir-schema.js";
import { formatSchemaIssues } from "./schema-utils.js";
import { sha256 } from "./stable.js";

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
