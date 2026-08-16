import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ArchitectureIRValidationError,
  loadSnapshot,
  validateArchitectureSnapshot,
  verifySnapshotReceipt,
} from "../src/index.js";

const fixturePath = path.resolve("test/fixtures/architecture-0.3.json");

test("accepts the committed Architecture IR 0.3 fixture and its receipt", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as unknown;
  const snapshot = validateArchitectureSnapshot(fixture, "IR 0.3 fixture");

  assert.doesNotThrow(() => verifySnapshotReceipt(snapshot, "IR 0.3 fixture"));
  assert.deepEqual(loadSnapshot(fixturePath), snapshot);
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
