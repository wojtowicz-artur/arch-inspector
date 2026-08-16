import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "../src/analyzer.js";
import { createProject, createSampleProject } from "./helpers/projects.js";

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

test("emits a machine-readable error envelope for JSON CLI failures", () => {
  const project = createProject({
    archConfig: { noCycles: "yes" },
    files: { "src/app.ts": "export const app = true;\n" },
  });
  try {
    const result = spawnSync(process.execPath, [cliPath, "check", project.root, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { error: boolean; code: string; message: string };
    assert.equal(payload.error, true);
    assert.equal(payload.code, "ANALYSIS_ERROR");
    assert.match(payload.message, /Invalid arch\.config\.json/);
  } finally {
    project.cleanup();
  }
});

test("emits deterministic SARIF findings for CI integrations", () => {
  const project = createProject({
    archConfig: {
      boundaryZones: {
        ui: { from: ["ui"], deny: ["infra"] },
      },
    },
    files: {
      "src/modules/ui/index.ts": 'import { infra } from "../infra";\nexport const view = infra;\n',
      "src/modules/infra/index.ts": "export const infra = true;\n",
    },
  });
  try {
    const first = spawnSync(process.execPath, [cliPath, "check", project.root, "--sarif"], { encoding: "utf8" });
    const second = spawnSync(process.execPath, [cliPath, "check", project.root, "--sarif"], { encoding: "utf8" });
    assert.equal(first.status, 0);
    assert.equal(first.stdout, second.stdout);
    const payload = JSON.parse(first.stdout) as {
      version: string;
      runs: Array<{ results: Array<{ ruleId: string; level: string; locations?: unknown[] }> }>;
    };
    assert.equal(payload.version, "2.1.0");
    assert.equal(payload.runs[0].results[0].ruleId, "architecture/boundary-violation");
    assert.equal(payload.runs[0].results[0].level, "error");
    assert.equal(payload.runs[0].results[0].locations?.length, 1);
  } finally {
    project.cleanup();
  }
});
