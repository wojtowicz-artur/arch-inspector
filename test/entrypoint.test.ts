import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeProject,
  BUILTIN_RULE_PACK,
  createRuleRegistry,
  diffSnapshots,
  evaluateRules,
  IR_CONTRACT,
  IR_VERSION,
  renderModuleGraphDot,
  type RuleSpec,
} from "../src/index.js";
import { createSampleProject } from "./helpers/projects.js";

test("public entrypoint exposes the library API", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const diff = diffSnapshots(snapshot, snapshot);

    assert.equal(IR_VERSION, "0.3");
    assert.deepEqual(IR_CONTRACT, {
      version: "0.3",
      compatibility: "exact",
      unknownFields: "reject",
      receipt: "required",
    });
    assert.equal(snapshot.irVersion, IR_VERSION);
    assert.equal(diff.hasRegressions, false);
    assert.match(renderModuleGraphDot(snapshot), /^digraph architecture \{/);
  } finally {
    project.cleanup();
  }
});

test("accepts custom declarative rule specifications", () => {
  const project = createSampleProject();
  try {
    const snapshot = analyzeProject(project.root);
    const customRule: RuleSpec = {
      code: "test/internal-cross-module-import",
      source: "imports",
      where: [
        { field: "isInternal", operator: "eq", value: true },
        { field: "isCrossModule", operator: "eq", value: true },
      ],
      finding: {
        category: "observation",
        level: "info",
        message: "${fromModule} reaches ${toModule}.",
        file: { field: "fromFile" },
      },
    };
    const findings = evaluateRules(
      {
        config: {},
        modules: snapshot.architecture.modules,
        imports: snapshot.source.imports,
        fileToModule: new Map(snapshot.architecture.ownership.map((entry) => [entry.file, entry.module])),
        moduleEntrypoints: new Map(
          snapshot.architecture.modules.map((module) => [module.id, new Set(module.entrypoints)]),
        ),
        cycles: snapshot.analysis.cycles,
      },
      [customRule],
    );

    assert.ok(findings.length > 0);
    assert.ok(findings.every((finding) => finding.code === customRule.code));
    assert.ok(findings.every((finding) => finding.provenance.rule === customRule.code));

    assert.throws(
      () =>
        evaluateRules(
          {
            config: {},
            modules: snapshot.architecture.modules,
            imports: snapshot.source.imports,
            fileToModule: new Map(snapshot.architecture.ownership.map((entry) => [entry.file, entry.module])),
            moduleEntrypoints: new Map(
              snapshot.architecture.modules.map((module) => [module.id, new Set(module.entrypoints)]),
            ),
            cycles: snapshot.analysis.cycles,
          },
          [{ ...customRule, where: [{ field: "isInternal", operator: "unsupported" }] } as unknown as RuleSpec],
        ),
      /Invalid rule specification/,
    );
  } finally {
    project.cleanup();
  }
});

test("builds a deterministic rule registry from versioned packs", () => {
  const customRule: RuleSpec = {
    code: "test/registry-rule",
    source: "imports",
    finding: {
      category: "observation",
      level: "info",
      message: "registry rule",
    },
  };
  const registry = createRuleRegistry([
    {
      id: "project/custom",
      version: "1.0.0",
      requiredFacts: ["imports"],
      rules: [customRule],
    },
    BUILTIN_RULE_PACK,
  ]);

  assert.deepEqual(
    registry.packs.map((pack) => pack.id),
    ["arch-inspector/core", "project/custom"],
  );
  assert.deepEqual(registry.requiredFacts, ["cycles", "forbiddenDependencies", "imports", "modules"]);
  assert.equal(registry.rules.length, BUILTIN_RULE_PACK.rules.length + 1);
  assert.throws(
    () =>
      createRuleRegistry([
        {
          id: "project/incomplete",
          version: "1.0.0",
          requiredFacts: ["modules"],
          rules: [customRule],
        },
      ]),
    /does not declare required fact 'imports'/,
  );
  assert.throws(
    () => createRuleRegistry([BUILTIN_RULE_PACK, { ...BUILTIN_RULE_PACK, id: "project/duplicate" }]),
    /Duplicate rule code: architecture\/cycle/,
  );
});
