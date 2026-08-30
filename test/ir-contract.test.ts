import assert from "node:assert/strict";
import test from "node:test";
import {
  ArchitectureIRValidationError,
  analyzeProject,
  IR_VERSION,
  validateArchitectureSnapshot,
  verifySnapshotReceipt,
} from "../src/index.js";
import { createSampleProject } from "./helpers/projects.js";

test("validates and verifies the current Architecture IR contract", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    assert.doesNotThrow(() => validateArchitectureSnapshot(snapshot, "IR 0.4 snapshot"));
    assert.doesNotThrow(() => verifySnapshotReceipt(snapshot, "IR 0.4 snapshot"));
    assert.equal(snapshot.irVersion, IR_VERSION);
    assert.equal(snapshot.receipt.toolVersion, "0.4.0");

    const tampered = structuredClone(snapshot);
    tampered.receipt.snapshotId = "0".repeat(64);
    assert.throws(() => verifySnapshotReceipt(tampered), /invalid snapshot receipt/);
  } finally {
    project.cleanup();
  }
});

test("reports the path of a malformed IR fact", () => {
  const project = createSampleProject();
  try {
    const fixture = structuredClone(analyzeProject(project.root));
    delete (fixture.analysis.metrics as { provenance?: unknown }).provenance;

    assert.throws(
      () => validateArchitectureSnapshot(fixture, "Malformed fixture"),
      (error: unknown) =>
        error instanceof ArchitectureIRValidationError &&
        error.issues.some((issue) => issue.includes("analysis.metrics.provenance")),
    );
  } finally {
    project.cleanup();
  }
});
