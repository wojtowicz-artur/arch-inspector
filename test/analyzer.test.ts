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
    assert.equal(first.irVersion, "0.2");
    assert.deepEqual(
      first.architecture.modules.map((module) => module.id),
      ["admin", "booking", "calendar", "shared"],
    );
    assert.equal(first.architecture.metrics.sourceFiles, 6);
    assert.ok(first.architecture.metrics.internalImports >= 5);
    assert.ok(first.architecture.metrics.externalImports >= 0);
    assert.equal(first.source.provenance.origin, "source");
    assert.equal(first.architecture.provenance.origin, "derived");
    assert.equal(first.source.files[0].provenance.origin, "source");
    assert.equal(first.architecture.modules.find((module) => module.id === "booking")?.provenance.origin, "inferred");
  } finally {
    project.cleanup();
  }
});

test("resolves path aliases and reports cycles and deep imports", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const aliasEdge = snapshot.source.edges.find((edge) => edge.specifier === "@modules/booking");
    assert.equal(aliasEdge?.resolution, "internal");
    assert.equal(aliasEdge?.publicApi, true);
    assert.ok(
      snapshot.architecture.cycles.some(
        (cycle) => cycle.modules.includes("booking") && cycle.modules.includes("calendar"),
      ),
    );
    assert.ok(snapshot.architecture.diagnostics.some((diagnostic) => diagnostic.code === "architecture/deep-import"));
    assert.ok(snapshot.architecture.diagnostics.some((diagnostic) => diagnostic.code === "architecture/cycle"));
  } finally {
    project.cleanup();
  }
});

test("applies analysis scope and configured public entrypoints", () => {
  const project = createScopedProject();
  try {
    const snapshot = analyzeProject(project.root);

    assert.equal(snapshot.architecture.metrics.sourceFiles, 3);
    assert.deepEqual(
      snapshot.source.files.map((file) => file.path),
      ["src/consumer.ts", "src/modules/booking/internal.ts", "src/modules/booking/public.ts"],
    );
    assert.deepEqual(
      snapshot.architecture.modules.map((module) => module.id),
      ["booking", "src"],
    );
    assert.deepEqual(snapshot.architecture.modules.find((module) => module.id === "booking")?.entrypoints, [
      "src/modules/booking/public.ts",
    ]);
    assert.equal(snapshot.architecture.metrics.assetImports, 1);
    assert.equal(snapshot.architecture.metrics.unresolvedImports, 0);
    assert.equal(
      snapshot.architecture.diagnostics.filter((diagnostic) => diagnostic.code === "architecture/deep-import").length,
      1,
    );
    assert.equal(snapshot.architecture.modules.find((module) => module.id === "booking")?.provenance.origin, "config");
  } finally {
    project.cleanup();
  }
});
