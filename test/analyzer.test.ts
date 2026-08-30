import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyzeProject } from "../src/analyzer.js";
import { diffSnapshots } from "../src/diff.js";
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

test("keeps module identity stable when a later module introduces a name collision", () => {
  const project = createProject({
    files: {
      "src/modules/auth/index.ts": "export const auth = true;\n",
      "src/app.ts": "export const app = true;\n",
    },
  });
  try {
    const before = analyzeProject(project.root);
    fs.mkdirSync(path.join(project.root, "src/features/auth"), { recursive: true });
    fs.writeFileSync(
      path.join(project.root, "src/features/auth/index.ts"),
      "export const featureAuth = true;\n",
      "utf8",
    );
    const after = analyzeProject(project.root);
    const diff = diffSnapshots(before, after);

    assert.equal(
      before.architecture.modules.find((module) => module.root === "src/modules/auth")?.stableId,
      "src/modules/auth",
    );
    assert.equal(
      after.architecture.modules.find((module) => module.root === "src/modules/auth")?.stableId,
      "src/modules/auth",
    );
    assert.equal(
      diff.architecture.modules.removed.some((module) => module.root === "src/modules/auth"),
      false,
    );
    assert.deepEqual(
      diff.architecture.modules.added.map((module) => module.root),
      ["src/features/auth"],
    );
  } finally {
    project.cleanup();
  }
});

test("preserves type-only import and export semantics", () => {
  const project = createProject({
    files: {
      "src/a.ts": 'import { type Value } from "./b";\nexport const value: Value = { id: "a" };\n',
      "src/c.ts": 'export type { Value } from "./b";\n',
      "src/b.ts": "export type Value = { id: string };\n",
    },
  });
  try {
    const imports = analyzeProject(project.root).source.imports;
    assert.equal(imports.find((edge) => edge.fromFile === "src/a.ts")?.typeOnly, true);
    assert.equal(imports.find((edge) => edge.fromFile === "src/c.ts")?.typeOnly, true);
  } finally {
    project.cleanup();
  }
});

test("distinguishes a resolved local file outside the configured analysis scope", () => {
  const project = createProject({
    include: ["src/a.ts"],
    files: {
      "src/a.ts": 'import { hidden } from "./hidden";\nexport const value = hidden;\n',
      "src/hidden.ts": "export const hidden = true;\n",
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    const edge = snapshot.source.imports.find((candidate) => candidate.fromFile === "src/a.ts");
    assert.equal(edge?.resolution, "out-of-scope");
    assert.equal(edge?.toFile, "src/hidden.ts");
    assert.equal(snapshot.analysis.metrics.outOfScopeImports, 1);
    assert.ok(snapshot.analysis.findings.some((finding) => finding.code === "architecture/out-of-scope-import"));
  } finally {
    project.cleanup();
  }
});

test("enforces declarative boundary zones with deterministic module selectors", () => {
  const project = createProject({
    archConfig: {
      boundaryZones: {
        ui: {
          from: ["ui"],
          allow: ["domain"],
          deny: ["infra"],
          message: "UI nie może zależeć od infrastruktury.",
        },
      },
    },
    files: {
      "src/modules/ui/index.ts": 'import { infra } from "../infra";\nexport const view = infra;\n',
      "src/modules/domain/index.ts": "export const domain = true;\n",
      "src/modules/infra/index.ts": "export const infra = true;\n",
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    const violations = snapshot.analysis.findings.filter(
      (finding) => finding.code === "architecture/boundary-violation",
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].data?.boundaryZone, "ui");
    assert.equal(violations[0].message, "UI nie może zależeć od infrastruktury.");
    assert.equal(violations[0].data?.from, "ui");
    assert.equal(violations[0].data?.to, "infra");
  } finally {
    project.cleanup();
  }
});

test("retains computed dynamic dependencies as ambiguous edges", () => {
  const project = createProject({
    files: {
      "src/app.ts":
        'const name = "home";\nexport const lazy = import(`./pages/${name}.js`);\nexport const loaded = require(loader);\n',
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    assert.deepEqual(
      snapshot.source.imports.map((edge) => [
        edge.importKind,
        edge.specifier,
        edge.resolution,
        edge.resolutionConfidence,
      ]),
      [
        ["dynamic", "./pages/*.js", "unresolved", "ambiguous"],
        ["require", "<dynamic>", "unresolved", "ambiguous"],
      ],
    );
    assert.equal(
      snapshot.analysis.findings.filter((finding) => finding.code === "architecture/dynamic-import-ambiguous").length,
      2,
    );
  } finally {
    project.cleanup();
  }
});

test("adds optional TypeScript checker evidence for imported exports", () => {
  const project = createProject({
    archConfig: { typeAware: true },
    files: {
      "src/app.ts":
        'import { type User, value as importedValue } from "./dep";\nexport { type User as PublicUser, value } from "./dep";\nexport const result: User = { id: importedValue };\n',
      "src/dep.ts": "export type User = { id: number };\nexport const value = 1;\n",
    },
  });
  try {
    const imports = analyzeProject(project.root).source.imports;
    const direct = imports.find((edge) => edge.importKind === "static");
    const reExport = imports.find((edge) => edge.importKind === "export");
    assert.deepEqual(direct?.symbols, [
      { name: "User", kind: "type" },
      { name: "value", kind: "value" },
    ]);
    assert.deepEqual(reExport?.symbols, [
      { name: "User", kind: "type" },
      { name: "value", kind: "value" },
    ]);
  } finally {
    project.cleanup();
  }
});

test("does not build checker metadata unless type-aware mode is enabled", () => {
  const project = createProject({
    files: {
      "src/app.ts": 'import { value } from "./dep";\nexport const result = value;\n',
      "src/dep.ts": "export const value = 1;\n",
    },
  });
  try {
    const edge = analyzeProject(project.root).source.imports[0];
    assert.equal(edge.symbols, undefined);
  } finally {
    project.cleanup();
  }
});

test("supports relative-path IDs for all inferred modules", () => {
  const project = createProject({
    archConfig: { moduleIdStrategy: "relative-path" },
    files: {
      "src/modules/auth/index.ts": "export const modulesAuth = true;\n",
      "src/features/auth/index.ts": "export const featuresAuth = true;\n",
      "src/modules/booking/index.ts": "export const booking = true;\n",
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    assert.deepEqual(
      snapshot.architecture.modules.map((module) => module.id),
      ["features/auth", "modules/auth", "modules/booking"],
    );
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
      rulePacks: [
        {
          id: "project/pack",
          version: "1.0.0",
          requiredFacts: ["imports"],
          rules: [
            {
              code: "project/pack-import",
              source: "imports",
              where: [{ field: "isInternal", operator: "eq", value: true }],
              finding: {
                category: "observation",
                level: "info",
                message: "pack: ${fromModule} imports ${toModule}.",
              },
            },
          ],
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
    assert.equal(snapshot.analysis.findings.filter((finding) => finding.code === "project/pack-import").length, 1);
  } finally {
    project.cleanup();
  }
});
