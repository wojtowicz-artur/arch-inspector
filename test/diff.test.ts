import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "../src/analyzer.js";
import { diffSnapshots, loadSnapshot } from "../src/diff.js";
import { createSampleProject } from "./helpers/projects.js";

test("diffs architecture snapshots by stable module, file, edge and diagnostic identities", () => {
  const project = createSampleProject();
  try {
    const base = analyzeProject(project.root);
    const current = structuredClone(base);
    current.architecture.modules = current.architecture.modules.filter((module) => module.id !== "shared");
    current.source.files = current.source.files.filter((file) => file.path !== "src/shared/index.ts");
    current.architecture.ownership = current.architecture.ownership.filter((entry) => entry.module !== "shared");
    current.architecture.moduleEdges = [
      ...current.architecture.moduleEdges,
      {
        id: "admin\0calendar",
        from: "admin",
        to: "calendar",
        imports: 1,
        publicApiImports: 1,
        deepImports: 0,
        files: ["src/modules/admin/index.ts"],
        sourceEdgeIds: [],
        visibility: "public",
        provenance: { origin: "derived" },
      },
    ];
    current.analysis.metrics.modules -= 1;
    current.analysis.metrics.moduleEdges += 1;
    current.analysis.metrics.deepImports += 1;
    current.analysis.findings = [
      ...current.analysis.findings,
      {
        code: "architecture/forbidden-dependency",
        category: "violation",
        level: "error",
        message: "admin is not allowed to depend on calendar.",
        file: "src/modules/admin/index.ts",
        line: 1,
        provenance: { origin: "derived" },
      },
    ];

    const diff = diffSnapshots(base, current, { base: "main", current: "working tree" });

    assert.equal(diff.base, "main");
    assert.deepEqual(
      diff.architecture.modules.removed.map((module) => module.id),
      ["shared"],
    );
    assert.equal(diff.architecture.moduleEdges.added[0].from, "admin");
    assert.equal(diff.introducedViolations[0].code, "architecture/forbidden-dependency");
    assert.equal(diff.analysis.metrics.modules.delta, -1);
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
    assert.equal(diff.architecture.modules.added.length, 0);
    assert.equal(diff.source.imports.removed.length, 0);
  } finally {
    project.cleanup();
  }
});

test("keeps import identity stable when only the source location moves", () => {
  const project = createSampleProject();
  try {
    const base = analyzeProject(project.root);
    const current = structuredClone(base);
    const moved = current.source.imports[0];
    moved.location.line += 10;

    const diff = diffSnapshots(base, current);

    assert.equal(diff.source.imports.added.length, 0);
    assert.equal(diff.source.imports.removed.length, 0);
    assert.equal(diff.source.imports.changed.length, 1);
  } finally {
    project.cleanup();
  }
});

test("snapshot loader validates the hardened IR shape and provenance", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const snapshotPath = path.join(project.root, "architecture.json");
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");
    assert.deepEqual(loadSnapshot(snapshotPath), snapshot);

    const tampered = JSON.parse(JSON.stringify(snapshot)) as ArchitectureSnapshotLike;
    tampered.analysis.metrics.imports += 1;
    fs.writeFileSync(snapshotPath, JSON.stringify(tampered), "utf8");
    assert.throws(() => loadSnapshot(snapshotPath), /invalid snapshot receipt/);

    const malformed = JSON.parse(JSON.stringify(snapshot)) as { source: { provenance?: unknown } };
    delete malformed.source.provenance;
    fs.writeFileSync(snapshotPath, JSON.stringify(malformed), "utf8");
    assert.throws(() => loadSnapshot(snapshotPath), /Architecture IR 0\.3 snapshot/);

    const legacy = JSON.parse(JSON.stringify(snapshot)) as { irVersion: string };
    legacy.irVersion = "0.1";
    fs.writeFileSync(snapshotPath, JSON.stringify(legacy), "utf8");
    assert.throws(() => loadSnapshot(snapshotPath), /Architecture IR 0\.3 snapshot/);

    const incomparable = structuredClone(snapshot);
    incomparable.receipt.configHash = "different";
    assert.throws(() => diffSnapshots(snapshot, incomparable), /not comparable/);
  } finally {
    project.cleanup();
  }
});

interface ArchitectureSnapshotLike {
  analysis: { metrics: { imports: number } };
}
