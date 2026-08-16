import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createSampleProject } from "./helpers/projects.js";
import { analyzeProject } from "../src/analyzer.js";
import { createProject } from "./helpers/projects.js";

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

test("audit gates only architecture violations introduced after a saved snapshot", () => {
  const project = createProject({
    files: {
      "src/modules/a/index.ts": 'import { b } from "../b";\nexport const a = b;\n',
      "src/modules/b/index.ts": "export const b = true;\n",
    },
  });
  try {
    const baselinePath = path.join(project.root, "baseline.json");
    fs.writeFileSync(baselinePath, `${JSON.stringify(analyzeProject(project.root), null, 2)}\n`, "utf8");
    fs.writeFileSync(
      path.join(project.root, "src/modules/b/index.ts"),
      'import { a } from "../a";\nexport const b = a;\n',
      "utf8",
    );

    const result = spawnSync(process.execPath, [cliPath, "audit", baselinePath, project.root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /regressions introduced/);
  } finally {
    project.cleanup();
  }
});
