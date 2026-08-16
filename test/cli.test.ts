import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createSampleProject } from "./helpers/projects.js";

const cliPath = path.resolve("dist/src/cli.js");

test("graph renders a deterministic module graph as Graphviz DOT", () => {
  const project = createSampleProject();
  try {
    const first = execFileSync(process.execPath, [cliPath, "graph", project.root], { encoding: "utf8" });
    const second = execFileSync(process.execPath, [cliPath, "graph", project.root], { encoding: "utf8" });

    assert.equal(first, second);
    assert.match(first, /^digraph architecture \{/);
    assert.match(first, /"admin" -> "booking"/);
    assert.match(first, /"booking" \[label="booking\\n2 files"/);
    assert.match(first, /color="#dc2626"/);
  } finally {
    project.cleanup();
  }
});

test("check exits non-zero for warning-level architecture violations", () => {
  const project = createSampleProject();
  try {
    const result = spawnSync(process.execPath, [cliPath, "check", project.root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /architecture\/deep-import/);
  } finally {
    project.cleanup();
  }
});
