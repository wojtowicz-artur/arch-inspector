import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { analyzeProject, diffSnapshots, IR_VERSION } from "../src/index.js";

test("public entrypoint exposes the library API", () => {
  const snapshot = analyzeProject(path.resolve("fixtures/sample"));
  const diff = diffSnapshots(snapshot, snapshot);

  assert.equal(IR_VERSION, "0.1");
  assert.equal(snapshot.irVersion, IR_VERSION);
  assert.equal(diff.hasRegressions, false);
});
