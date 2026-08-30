import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ArchitectureIRValidationError,
  analyzeProject,
  IR_VERSION,
  validateArchitectureSnapshot,
  verifySnapshotReceipt,
} from "../src/index.js";
import { diffSnapshots, loadSnapshot } from "../src/diff.js";
import { sha256 } from "../src/stable.js";
import { createSampleProject } from "./helpers/projects.js";

test("validates and verifies the current Architecture IR contract", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    assert.doesNotThrow(() => validateArchitectureSnapshot(snapshot, "IR 0.5 snapshot"));
    assert.doesNotThrow(() => verifySnapshotReceipt(snapshot, "IR 0.5 snapshot"));
    assert.equal(snapshot.irVersion, IR_VERSION);
    assert.equal(snapshot.receipt.toolVersion, "0.5.0");
    assert.equal(snapshot.receipt.pipelineHash, sha256(snapshot.receipt.pipeline));

    const tampered = structuredClone(snapshot);
    tampered.receipt.snapshotId = "0".repeat(64);
    assert.throws(() => verifySnapshotReceipt(tampered), /invalid snapshot receipt/);

    const changedPipeline = structuredClone(snapshot);
    changedPipeline.receipt.pipelineHash = "0".repeat(64);
    assert.throws(() => verifySnapshotReceipt(changedPipeline), /invalid snapshot receipt/);

    const changedManifest = structuredClone(snapshot);
    changedManifest.receipt.pipeline.providers = [
      ...changedManifest.receipt.pipeline.providers,
      { id: "test/provider", version: "1.0.0" },
    ];
    const changedManifestBase = {
      irVersion: changedManifest.irVersion,
      project: changedManifest.project,
      policy: changedManifest.policy,
      source: changedManifest.source,
      architecture: changedManifest.architecture,
      analysis: changedManifest.analysis,
    };
    changedManifest.receipt.snapshotId = sha256({
      ...changedManifestBase,
      receipt: { ...changedManifest.receipt, snapshotId: "" },
    });
    assert.throws(() => verifySnapshotReceipt(changedManifest), /invalid snapshot receipt/);
  } finally {
    project.cleanup();
  }
});

test("accepts semver patch tool versions but keeps analyzer versions incomparable", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const patched = structuredClone(snapshot);
    const snapshotBase = {
      irVersion: patched.irVersion,
      project: patched.project,
      policy: patched.policy,
      source: patched.source,
      architecture: patched.architecture,
      analysis: patched.analysis,
    };
    patched.receipt.toolVersion = "0.5.1";
    patched.receipt.snapshotId = sha256({
      ...snapshotBase,
      receipt: { ...patched.receipt, snapshotId: "" },
    });

    assert.doesNotThrow(() => validateArchitectureSnapshot(patched, "IR 0.5.1 snapshot"));
    assert.doesNotThrow(() => verifySnapshotReceipt(patched, "IR 0.5.1 snapshot"));
    const snapshotPath = path.join(project.root, "architecture-0.5.1.json");
    fs.writeFileSync(snapshotPath, JSON.stringify(patched), "utf8");
    assert.deepEqual(loadSnapshot(snapshotPath), patched);
    assert.throws(() => diffSnapshots(snapshot, patched), /tool 0\.5\.0 != 0\.5\.1/);

    const invalid = structuredClone(patched);
    invalid.receipt.toolVersion = "0.5";
    assert.throws(() => validateArchitectureSnapshot(invalid), /valid semantic version/);
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
