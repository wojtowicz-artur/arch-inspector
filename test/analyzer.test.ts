import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "../src/analyzer.js";

const fixture = path.resolve("fixtures/sample");

test("builds a deterministic architecture snapshot from a TypeScript project", () => {
  const first = analyzeProject(fixture);
  const second = analyzeProject(fixture);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.irVersion, "0.1");
  assert.deepEqual(first.modules.map((module) => module.id), ["admin", "booking", "calendar", "shared"]);
  assert.equal(first.metrics.sourceFiles, 6);
  assert.ok(first.metrics.internalImports >= 5);
  assert.ok(first.metrics.externalImports >= 0);
});

test("resolves path aliases and reports cycles and deep imports", () => {
  const snapshot = analyzeProject(fixture);
  const aliasEdge = snapshot.edges.find((edge) => edge.specifier === "@modules/booking");
  assert.equal(aliasEdge?.resolution, "internal");
  assert.equal(aliasEdge?.publicApi, true);
  assert.ok(snapshot.cycles.some((cycle) => cycle.includes("booking") && cycle.includes("calendar")));
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "architecture/deep-import"));
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "architecture/cycle"));
});
