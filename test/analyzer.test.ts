import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProject } from "../src/analyzer.js";
import { createSampleProject, createScopedProject } from "./helpers/projects.js";

test("builds a deterministic architecture snapshot from a TypeScript project", () => {
  const project = createSampleProject();
  try {
    const first = analyzeProject(project.root);
    const second = analyzeProject(project.root);

    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.irVersion, "0.1");
    assert.deepEqual(first.modules.map((module) => module.id), ["admin", "booking", "calendar", "shared"]);
    assert.equal(first.metrics.sourceFiles, 6);
    assert.ok(first.metrics.internalImports >= 5);
    assert.ok(first.metrics.externalImports >= 0);
  } finally {
    project.cleanup();
  }
});

test("resolves path aliases and reports cycles and deep imports", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const aliasEdge = snapshot.edges.find((edge) => edge.specifier === "@modules/booking");
    assert.equal(aliasEdge?.resolution, "internal");
    assert.equal(aliasEdge?.publicApi, true);
    assert.ok(snapshot.cycles.some((cycle) => cycle.includes("booking") && cycle.includes("calendar")));
    assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "architecture/deep-import"));
    assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "architecture/cycle"));
  } finally {
    project.cleanup();
  }
});

test("applies analysis scope and configured public entrypoints", () => {
  const project = createScopedProject();
  try {
    const snapshot = analyzeProject(project.root);

    assert.equal(snapshot.metrics.sourceFiles, 3);
    assert.deepEqual(snapshot.files.map((file) => file.path), [
      "src/consumer.ts",
      "src/modules/booking/internal.ts",
      "src/modules/booking/public.ts",
    ]);
    assert.deepEqual(snapshot.modules.map((module) => module.id), ["booking", "src"]);
    assert.deepEqual(snapshot.modules.find((module) => module.id === "booking")?.entrypoints, ["src/modules/booking/public.ts"]);
    assert.equal(snapshot.metrics.assetImports, 1);
    assert.equal(snapshot.metrics.unresolvedImports, 0);
    assert.equal(snapshot.diagnostics.filter((diagnostic) => diagnostic.code === "architecture/deep-import").length, 1);
  } finally {
    project.cleanup();
  }
});
