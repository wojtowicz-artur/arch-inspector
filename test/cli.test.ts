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

test("check is report-only until a finding policy is explicitly selected", () => {
  const project = createSampleProject();
  try {
    const report = spawnSync(process.execPath, [cliPath, "check", project.root], { encoding: "utf8" });
    assert.equal(report.status, 0);
    assert.match(report.stdout, /architecture\/deep-import/);

    const enforced = spawnSync(process.execPath, [cliPath, "check", project.root, "--fail-on", "deep-imports"], {
      encoding: "utf8",
    });
    assert.equal(enforced.status, 1);
    assert.match(enforced.stdout, /architecture\/deep-import/);
  } finally {
    project.cleanup();
  }
});
