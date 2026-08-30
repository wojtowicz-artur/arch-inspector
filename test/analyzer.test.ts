import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyzeProject, createAnalyzerSession } from "../src/analyzer.js";
import { diffSnapshots } from "../src/diff.js";
import { findingKey } from "../src/finding-identity.js";
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
    assert.equal(first.irVersion, "0.5");
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
    assert.equal(first.receipt.pipelineHash.length, 64);
    assert.deepEqual(
      first.receipt.pipeline.providers.map((component) => component.id),
      ["architecture/module-inference", "typescript/source-files", "typescript/imports"],
    );
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

test("does not expose nested index barrels as public module entrypoints", () => {
  const project = createProject({
    compilerOptions: { rootDir: "." },
    files: {
      "src/modules/a/index.ts": 'export { value } from "./internal/index";\n',
      "src/modules/a/internal/index.ts": "export const value = true;\n",
      "src/modules/b/index.ts": 'import { value } from "../a/internal/index";\nexport const result = value;\n',
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    assert.deepEqual(snapshot.architecture.modules.find((module) => module.id === "a")?.entrypoints, [
      "src/modules/a/index.ts",
    ]);
    assert.equal(snapshot.architecture.modules.find((module) => module.id === "b")?.entrypoints.length, 1);
    assert.equal(snapshot.analysis.metrics.deepImports, 1);
    assert.equal(snapshot.analysis.findings.filter((finding) => finding.code === "architecture/deep-import").length, 1);
  } finally {
    project.cleanup();
  }
});

test("keeps unresolved and out-of-scope project aliases visible", () => {
  const project = createProject({
    include: ["src/app.ts"],
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@missing/*": ["src/missing/*"],
        "@hidden/*": ["src/hidden/*"],
      },
    },
    files: {
      "src/app.ts":
        'import missing from "@missing/value";\nimport hidden from "@hidden/value";\nexport const result = missing && hidden;\n',
      "src/hidden/value.ts": "export default true;\n",
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    const missing = snapshot.source.imports.find((edge) => edge.specifier === "@missing/value");
    const hidden = snapshot.source.imports.find((edge) => edge.specifier === "@hidden/value");
    assert.equal(missing?.resolution, "unresolved");
    assert.equal(missing?.isProjectAlias, true);
    assert.equal(hidden?.resolution, "out-of-scope");
    assert.equal(hidden?.toFile, "src/hidden/value.ts");
    assert.equal(snapshot.analysis.metrics.unresolvedImports, 1);
    assert.equal(snapshot.analysis.metrics.outOfScopeImports, 1);
    assert.equal(
      snapshot.analysis.findings.filter((finding) => finding.code === "architecture/unresolved-import").length,
      1,
    );
    assert.equal(
      snapshot.analysis.findings.filter((finding) => finding.code === "architecture/out-of-scope-import").length,
      1,
    );
  } finally {
    project.cleanup();
  }
});

test("discovers src modules when compiler rootDir is the project root", () => {
  const project = createProject({
    compilerOptions: { rootDir: "." },
    files: {
      "src/modules/a/index.ts": "export const a = true;\n",
      "src/modules/b/index.ts": "export const b = true;\n",
      "tests/inspector.ts": "export const test = true;\n",
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    assert.equal(snapshot.project.sourceRoot, "src");
    assert.ok(snapshot.architecture.modules.some((module) => module.id === "a"));
    assert.ok(snapshot.architecture.modules.some((module) => module.id === "b"));
  } finally {
    project.cleanup();
  }
});

test("keeps type-aware analysis in each project-reference compiler context", () => {
  const project = createProject({
    archConfig: { typeAware: true },
    compilerOptions: { rootDir: "." },
    files: {
      "src/app.ts":
        'import { type User, value } from "../packages/lib/src/index";\nexport const result: User = { id: value };\n',
      "packages/lib/src/index.ts": "export type User = { id: number };\nexport const value = 1;\n",
    },
  });
  try {
    fs.writeFileSync(
      path.join(project.root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            rootDir: ".",
            baseUrl: ".",
          },
          include: ["src/**/*.ts"],
          references: [{ path: "packages/lib" }],
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(project.root, "packages/lib/tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "CommonJS",
            moduleResolution: "Node10",
            rootDir: "src",
            composite: true,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const snapshot = analyzeProject(project.root);
    const edge = snapshot.source.imports.find((candidate) => candidate.fromFile === "src/app.ts");
    assert.equal(snapshot.project.sourceRoot, "src");
    assert.deepEqual(edge?.symbols, [
      { name: "User", kind: "type" },
      { name: "value", kind: "value" },
    ]);
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

test("does not reintroduce an existing cycle when a module name becomes namespaced", () => {
  const project = createProject({
    files: {
      "src/modules/auth/index.ts": 'import { b } from "../b";\nexport const auth = b;\n',
      "src/modules/b/index.ts": 'import { auth } from "../auth";\nexport const b = auth;\n',
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

    assert.equal(diff.analysis.cycles.added.length, 0);
    assert.equal(
      diff.analysis.findings.added.some((finding) => finding.code === "architecture/cycle"),
      false,
    );
    assert.equal(
      diff.introducedViolations.some((finding) => finding.code === "architecture/cycle"),
      false,
    );
    assert.equal(diff.hasRegressions, false);
  } finally {
    project.cleanup();
  }
});

test("does not reintroduce a deep import when a module name becomes namespaced", () => {
  const project = createProject({
    files: {
      "src/modules/auth/index.ts": 'import { b } from "../b/internal";\nexport const auth = b;\n',
      "src/modules/b/index.ts": "export const b = true;\n",
      "src/modules/b/internal.ts": "export const b = true;\n",
    },
  });
  try {
    const before = analyzeProject(project.root);
    assert.equal(before.analysis.findings.filter((finding) => finding.code === "architecture/deep-import").length, 1);

    fs.mkdirSync(path.join(project.root, "src/features/auth"), { recursive: true });
    fs.writeFileSync(
      path.join(project.root, "src/features/auth/index.ts"),
      "export const featureAuth = true;\n",
      "utf8",
    );
    const after = analyzeProject(project.root);
    const diff = diffSnapshots(before, after);

    assert.equal(
      diff.analysis.findings.added.some((finding) => finding.code === "architecture/deep-import"),
      false,
    );
    assert.equal(
      diff.analysis.findings.removed.some((finding) => finding.code === "architecture/deep-import"),
      false,
    );
    assert.equal(
      diff.introducedViolations.some((finding) => finding.code === "architecture/deep-import"),
      false,
    );
    assert.equal(
      diff.analysis.findings.changed.filter((finding) => finding.after.code === "architecture/deep-import").length,
      1,
    );
    assert.equal(diff.hasRegressions, false);
  } finally {
    project.cleanup();
  }
});

test("does not reintroduce a cycle when a redundant module edge is added", () => {
  const project = createProject({
    files: {
      "src/modules/a/index.ts": 'import { b } from "../b";\nexport const a = b;\n',
      "src/modules/b/index.ts": 'import { a } from "../a";\nexport const b = a;\n',
    },
  });
  try {
    const before = analyzeProject(project.root);
    assert.equal(before.analysis.cycles.length, 1);
    fs.writeFileSync(
      path.join(project.root, "src/modules/a/index.ts"),
      'import { b } from "../b";\nimport { b as again } from "../b";\nexport const a = b && again;\n',
      "utf8",
    );
    const after = analyzeProject(project.root);
    const diff = diffSnapshots(before, after);

    assert.equal(diff.analysis.cycles.added.length, 0);
    assert.equal(
      diff.analysis.findings.added.some((finding) => finding.code === "architecture/cycle"),
      false,
    );
    assert.equal(
      diff.introducedViolations.some((finding) => finding.code === "architecture/cycle"),
      false,
    );
    assert.equal(
      diff.analysis.findings.changed.filter((finding) => finding.after.code === "architecture/cycle").length,
      1,
    );
    assert.equal(diff.hasRegressions, false);
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

test("preserves unknown public visibility when a module has no known entrypoint", () => {
  const project = createProject({
    files: {
      "src/modules/client/index.ts":
        'import { internal } from "../library/internal";\nexport const value = internal;\n',
      "src/modules/library/internal.ts": "export const internal = true;\n",
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    const edge = snapshot.architecture.moduleEdges.find((candidate) => candidate.from === "client");
    assert.equal(edge?.to, "library");
    assert.equal(edge?.visibility, "unknown");
    assert.equal(edge?.unknownImports, 1);
    assert.equal(edge?.deepImports, 0);
    assert.equal(snapshot.analysis.metrics.unknownVisibilityImports, 1);
    assert.equal(snapshot.analysis.findings.filter((finding) => finding.code === "architecture/deep-import").length, 0);
    assert.equal(
      snapshot.analysis.findings.filter((finding) => finding.code === "architecture/no-public-entrypoint").length,
      1,
    );
  } finally {
    project.cleanup();
  }
});

test("does not classify an unresolved workspace package as external", () => {
  const project = createProject({
    files: {
      "src/app.ts": 'import { value } from "@workspace/library";\nexport const result = value;\n',
    },
  });
  try {
    fs.mkdirSync(path.join(project.root, "packages/library"), { recursive: true });
    fs.writeFileSync(
      path.join(project.root, "package.json"),
      JSON.stringify({ name: "workspace-root", workspaces: ["packages/*"] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(project.root, "packages/library/package.json"),
      JSON.stringify({ name: "@workspace/library" }),
      "utf8",
    );

    const snapshot = analyzeProject(project.root);
    const edge = snapshot.source.imports.find((candidate) => candidate.specifier === "@workspace/library");
    assert.equal(edge?.resolution, "unresolved");
    assert.equal(edge?.resolutionConfidence, "ambiguous");
    assert.equal(edge?.isProjectLike, true);
    assert.equal(snapshot.analysis.metrics.externalImports, 0);
    assert.equal(
      snapshot.analysis.findings.filter((finding) => finding.code === "architecture/unresolved-import").length,
      1,
    );
  } finally {
    project.cleanup();
  }
});

test("keeps a resolved repo-local bare import out of the external category", () => {
  const project = createProject({
    compilerOptions: { baseUrl: "." },
    files: {
      "src/app.ts": 'import { value } from "packages/library/src";\nexport const result = value;\n',
      "packages/library/src/index.ts": "export const value = true;\n",
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    const edge = snapshot.source.imports.find((candidate) => candidate.specifier === "packages/library/src");
    assert.equal(edge?.resolution, "out-of-scope");
    assert.equal(edge?.toFile, "packages/library/src/index.ts");
    assert.equal(snapshot.analysis.metrics.externalImports, 0);
    assert.equal(snapshot.analysis.metrics.outOfScopeImports, 1);
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

test("reuses an analyzer session and invalidates semantic caches when sources change", () => {
  const project = createProject({
    archConfig: { typeAware: true },
    files: {
      "src/app.ts": 'import { Item } from "./dep";\nexport const value = new Item();\n',
      "src/dep.ts": "export class Item {}\n",
    },
  });
  try {
    const session = createAnalyzerSession();
    const first = session.analyze(project.root);
    const repeated = session.analyze(project.root);
    assert.equal(repeated.receipt.snapshotId, first.receipt.snapshotId);
    assert.deepEqual(first.source.imports[0]?.symbols, [{ name: "Item", kind: "both" }]);

    fs.writeFileSync(path.join(project.root, "src/dep.ts"), "export interface Item {}\n", "utf8");
    const changed = session.analyze(project.root);
    assert.notEqual(changed.receipt.inputHash, first.receipt.inputHash);
    assert.deepEqual(changed.source.imports[0]?.symbols, [{ name: "Item", kind: "type" }]);
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

test("rejects unknown failOn selectors and missing configured module roots", () => {
  const unknownPolicy = createProject({
    archConfig: { failOn: ["deep-improt"] },
    files: { "src/app.ts": "export const app = true;\n" },
  });
  const missingRoot = createProject({
    archConfig: { moduleRoots: ["src/not-a-module"] },
    files: { "src/app.ts": "export const app = true;\n" },
  });
  try {
    assert.throws(() => analyzeProject(unknownPolicy.root), /Unknown failOn selector/);
    assert.throws(() => analyzeProject(missingRoot.root), /Configured module root does not exist/);
  } finally {
    unknownPolicy.cleanup();
    missingRoot.cleanup();
  }
});

test("accepts canonical and short built-in failOn selectors", () => {
  const project = createProject({
    archConfig: {
      failOn: ["boundary-violation", "architecture/deep-import", "unresolved-import", "no-public-entrypoint"],
    },
    files: { "src/app.ts": "export const app = true;\n" },
  });
  try {
    assert.doesNotThrow(() => analyzeProject(project.root));
  } finally {
    project.cleanup();
  }
});

test("uses custom forbidden dependency messages", () => {
  const project = createProject({
    archConfig: {
      forbiddenDependencies: [{ from: "a", to: "b", message: "CUSTOM" }],
    },
    files: {
      "src/modules/a/index.ts": 'import { b } from "../b";\nexport const a = b;\n',
      "src/modules/b/index.ts": "export const b = true;\n",
    },
  });
  try {
    const finding = analyzeProject(project.root).analysis.findings.find(
      (candidate) => candidate.code === "architecture/forbidden-dependency",
    );
    assert.equal(finding?.message, "CUSTOM");
  } finally {
    project.cleanup();
  }
});

test("keeps duplicate forbidden dependency rules distinct in finding identity", () => {
  const project = createProject({
    archConfig: {
      forbiddenDependencies: [
        { from: "a", to: "b", message: "first" },
        { from: "a", to: "b", message: "second" },
      ],
    },
    files: {
      "src/modules/a/index.ts": 'import { b } from "../b";\nexport const a = b;\n',
      "src/modules/b/index.ts": "export const b = true;\n",
    },
  });
  try {
    const findings = analyzeProject(project.root).analysis.findings.filter(
      (candidate) => candidate.code === "architecture/forbidden-dependency",
    );
    assert.equal(findings.length, 2);
    assert.notEqual(findingKey(findings[0]), findingKey(findings[1]));
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
