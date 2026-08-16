import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProject } from "../src/analyzer.js";
import { diffSnapshots } from "../src/diff.js";
import { createSampleProject } from "./helpers/projects.js";

test("diffs architecture snapshots by stable module, file, edge and diagnostic identities", () => {
  const project = createSampleProject();
  try {
    const base = analyzeProject(project.root);
    const current = structuredClone(base);
    current.modules = current.modules.filter((module) => module.id !== "shared");
    current.files = current.files.filter((file) => file.moduleId !== "shared");
    current.moduleEdges = [...current.moduleEdges, { from: "admin", to: "calendar", imports: 1, publicApiImports: 1, files: ["src/modules/admin/index.ts"] }];
    current.metrics.modules -= 1;
    current.metrics.moduleEdges += 1;
    current.metrics.deepImports += 1;
    current.diagnostics = [...current.diagnostics, {
      code: "architecture/forbidden-dependency",
      category: "violation",
      level: "error",
      message: "admin is not allowed to depend on calendar.",
      file: "src/modules/admin/index.ts",
      line: 1,
    }];

    const diff = diffSnapshots(base, current, { base: "main", current: "working tree" });

    assert.equal(diff.base, "main");
    assert.deepEqual(diff.modules.removed.map((module) => module.id), ["shared"]);
    assert.equal(diff.moduleEdges.added[0].from, "admin");
    assert.equal(diff.introducedViolations[0].code, "architecture/forbidden-dependency");
    assert.equal(diff.metrics.modules.delta, -1);
    assert.equal(diff.hasRegressions, true);
  } finally {
    project.cleanup();
  }
});

test("a clean snapshot diff has no regressions", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const diff = diffSnapshots(snapshot, snapshot);
    assert.equal(diff.hasRegressions, false);
    assert.equal(diff.modules.added.length, 0);
    assert.equal(diff.edges.removed.length, 0);
  } finally {
    project.cleanup();
  }
});
