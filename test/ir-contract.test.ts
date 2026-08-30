import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ArchitectureIRValidationError,
  loadSnapshot,
  migrateArchitectureSnapshot,
  IR_VERSION,
  validateArchitectureSnapshot,
  verifySnapshotReceipt,
} from "../src/index.js";

const fixturePath = path.resolve("test/fixtures/architecture-0.3.json");

test("migrates the committed Architecture IR 0.3 fixture and verifies its receipt", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as unknown;
  assert.throws(() => validateArchitectureSnapshot(fixture, "IR 0.3 fixture"), /Architecture IR 0\.4 snapshot/);
  const snapshot = migrateArchitectureSnapshot(fixture, "IR 0.3 fixture");

  assert.doesNotThrow(() => verifySnapshotReceipt(snapshot, "IR 0.3 fixture"));
  const loaded = loadSnapshot(fixturePath);
  assert.deepEqual(loaded, snapshot);
  assert.equal(loaded.irVersion, IR_VERSION);
  assert.equal(loaded.receipt.toolVersion, "0.4.0");
  assert.equal(
    loaded.architecture.moduleEdges.every((edge) => edge.unknownImports === 0),
    true,
  );
  assert.equal(loaded.analysis.metrics.unknownVisibilityImports, 0);

  const tampered = structuredClone(fixture) as { receipt: { snapshotId: string } };
  tampered.receipt.snapshotId = "0".repeat(64);
  assert.throws(() => migrateArchitectureSnapshot(tampered), /invalid snapshot receipt/);
});

test("reports the path of a malformed IR fact", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    analysis: { metrics: { provenance?: unknown } };
  };
  delete fixture.analysis.metrics.provenance;

  assert.throws(
    () => validateArchitectureSnapshot(fixture, "Malformed fixture"),
    (error: unknown) =>
      error instanceof ArchitectureIRValidationError &&
      error.issues.some((issue) => issue.includes("analysis.metrics.provenance")),
  );
});
