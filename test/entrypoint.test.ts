import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProject, diffSnapshots, IR_VERSION } from "../src/index.js";
import { createSampleProject } from "./helpers/projects.js";

test("public entrypoint exposes the library API", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const diff = diffSnapshots(snapshot, snapshot);

    assert.equal(IR_VERSION, "0.1");
    assert.equal(snapshot.irVersion, IR_VERSION);
    assert.equal(diff.hasRegressions, false);
  } finally {
    project.cleanup();
  }
});
