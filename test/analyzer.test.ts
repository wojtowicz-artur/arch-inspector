import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProject } from "../src/analyzer.js";
import {
  createCollidingModulesProject,
  createProject,
  createSampleProject,
  createScopedProject,
} from "./helpers/projects.js";

test("builds a deterministic architecture snapshot from a TypeScript project", () => {
  const project = createSampleProject();
  try {
    const first = analyzeProject(project.root);
    const second = analyzeProject(project.root);

    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.irVersion, "0.3");
    assert.deepEqual(
      first.architecture.modules.map((module) => module.id),
      ["admin", "booking", "calendar", "shared"],
    );
    assert.equal(first.analysis.metrics.sourceFiles, 6);
    assert.ok(first.analysis.metrics.internalImports >= 5);
    assert.ok(first.analysis.metrics.externalImports >= 0);
    assert.equal(first.source.provenance.origin, "observed");
    assert.equal(first.architecture.provenance.origin, "derived");
    assert.equal(first.source.files[0].provenance.origin, "observed");
    assert.equal(first.architecture.modules.find((module) => module.id === "booking")?.provenance.origin, "inferred");
    assert.equal(first.receipt.snapshotId.length, 64);
    assert.equal(first.receipt.snapshotId, second.receipt.snapshotId);
  } finally {
    project.cleanup();
  }
});

test("resolves path aliases and reports cycles and deep imports", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const aliasEdge = snapshot.source.imports.find((edge) => edge.specifier === "@modules/booking");
    assert.equal(aliasEdge?.resolution, "internal");
    assert.equal(aliasEdge?.toFile, "src/modules/booking/index.ts");
    assert.equal(
      snapshot.architecture.moduleEdges.find((edge) => edge.from === "admin" && edge.to === "booking")
        ?.publicApiImports,
      1,
    );
    assert.ok(
      snapshot.analysis.cycles.some((cycle) => cycle.modules.includes("booking") && cycle.modules.includes("calendar")),
    );
    assert.ok(snapshot.analysis.findings.some((finding) => finding.code === "architecture/deep-import"));
    assert.ok(snapshot.analysis.findings.some((finding) => finding.code === "architecture/cycle"));
  } finally {
    project.cleanup();
  }
});

test("applies analysis scope and configured public entrypoints", () => {
  const project = createScopedProject();
  try {
    const snapshot = analyzeProject(project.root);

    assert.equal(snapshot.analysis.metrics.sourceFiles, 3);
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
    assert.equal(snapshot.analysis.metrics.assetImports, 1);
    assert.equal(snapshot.analysis.metrics.unresolvedImports, 0);
    assert.equal(snapshot.analysis.findings.filter((finding) => finding.code === "architecture/deep-import").length, 1);
    assert.equal(
      snapshot.architecture.modules.find((module) => module.id === "booking")?.provenance.origin,
      "declared",
    );
    assert.equal(
      snapshot.architecture.ownership.find((entry) => entry.file.endsWith("booking/internal.ts"))?.module,
      "booking",
    );
  } finally {
    project.cleanup();
  }
});

test("namespaces colliding inferred module ids by root", () => {
  const project = createCollidingModulesProject();
  try {
    const snapshot = analyzeProject(project.root);

    assert.deepEqual(
      snapshot.architecture.modules.map((module) => module.id),
      ["features/auth", "modules/auth", "src"],
    );
    assert.equal(
      snapshot.architecture.ownership.find((entry) => entry.file === "src/features/auth/index.ts")?.module,
      "features/auth",
    );
    assert.equal(
      snapshot.architecture.ownership.find((entry) => entry.file === "src/modules/auth/index.ts")?.module,
      "modules/auth",
    );
    assert.equal(snapshot.architecture.ownership.find((entry) => entry.file === "src/app.ts")?.module, "src");
  } finally {
    project.cleanup();
  }
});

test("rejects malformed project configuration at the boundary", () => {
  const project = createProject({
    archConfig: { noCycles: "yes" },
    files: { "src/app.ts": "export const app = true;\n" },
  });
  try {
    assert.throws(() => analyzeProject(project.root), /Invalid arch\.config\.json: noCycles/);
  } finally {
    project.cleanup();
  }
});

test("loads custom declarative rules from project configuration", () => {
  const project = createProject({
    archConfig: {
      rules: [
        {
          code: "project/internal-import",
          source: "imports",
          where: [{ field: "isInternal", operator: "eq", value: true }],
          finding: {
            category: "observation",
            level: "info",
            message: "${fromModule} imports ${toModule}.",
            file: { field: "fromFile" },
          },
        },
      ],
    },
    files: {
      "src/modules/a/index.ts": 'import { b } from "../b/index";\nexport const a = b;\n',
      "src/modules/b/index.ts": "export const b = true;\n",
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    const customFindings = snapshot.analysis.findings.filter((finding) => finding.code === "project/internal-import");
    assert.equal(customFindings.length, 1);
    assert.equal(customFindings[0].file, "src/modules/a/index.ts");
    assert.equal(customFindings[0].message, "a imports b.");
  } finally {
    project.cleanup();
  }
});
