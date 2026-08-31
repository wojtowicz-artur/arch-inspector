import assert from "node:assert/strict";
import test from "node:test";
import {
  defineCommand,
  defineEvent,
  defineModule,
  defineQuery,
  type InputOf,
  type OutputOf,
  type PayloadOf,
} from "@arch-inspector/contracts";
import { analyzeProject } from "../src/analyzer.js";
import { renderInteractionGraphDot } from "../src/graph.js";
import { createProject } from "./helpers/projects.js";

test("materializes immutable typed contracts with deterministic ids", () => {
  const owner = defineModule({
    id: "owner",
    publicEntrypoints: ["./index.ts"],
    queries: { lookup: defineQuery<{ id: string }, { found: boolean }>() },
    commands: { refresh: defineCommand<{ id: string }, { accepted: boolean }>() },
    events: { refreshed: defineEvent<{ id: string }>() },
  });
  const consumer = defineModule({
    id: "consumer",
    requires: [owner.queries.lookup, owner.commands.refresh],
    subscribesTo: [owner.events.refreshed],
  });

  assert.deepEqual(owner.queries.lookup, {
    id: "owner:query:lookup",
    key: "lookup",
    module: "owner",
    kind: "query",
  });
  assert.equal(owner.commands.refresh.id, "owner:command:refresh");
  assert.equal(owner.events.refreshed.id, "owner:event:refreshed");
  assert(Object.isFrozen(owner));
  assert(Object.isFrozen(owner.queries));
  assert(Object.isFrozen(owner.queries.lookup));
  assert(Object.isFrozen(consumer.requires));
  assert.throws(
    () =>
      defineModule({
        id: "invalid",
        queries: { wrong: defineEvent() as never },
      }),
    /query contract/,
  );
  assert.throws(
    () => defineModule({ id: "invalid", requires: [owner.queries.lookup, owner.queries.lookup] }),
    /duplicate contract reference/,
  );

  const input: InputOf<typeof owner.queries.lookup> = { id: "x" };
  const output: OutputOf<typeof owner.queries.lookup> = { found: true };
  const payload: PayloadOf<typeof owner.events.refreshed> = { id: "x" };
  assert.deepEqual([input, output, payload], [{ id: "x" }, { found: true }, { id: "x" }]);
});

test("extracts declarations and projects interactions without executing application code", () => {
  const project = createProject({
    files: {
      "src/calendar/index.ts": "export const calendar = true;\n",
      "src/calendar/module.arch.ts":
        'import { defineEvent, defineModule, defineQuery } from "@arch-inspector/contracts";\nexport const Calendar = defineModule({ id: "calendar", publicEntrypoints: ["./index.ts"], queries: { availability: defineQuery() }, events: { reserved: defineEvent() } });\n',
      "src/booking/index.ts": 'import { calendar } from "../calendar/index"; export const booking = calendar;\n',
      "src/booking/module.arch.ts":
        'import { defineModule } from "@arch-inspector/contracts";\nimport { Calendar } from "../calendar/module.arch.js";\nexport const Booking = defineModule({ id: "booking", publicEntrypoints: ["./index.ts"], requires: [Calendar.queries.availability], subscribesTo: [Calendar.events.reserved] });\n',
      "src/application.ts": 'throw new Error("application code must not execute");\n',
    },
  });
  try {
    const snapshot = analyzeProject(project.root);
    assert.deepEqual(
      snapshot.architecture.modules.map((module) => [module.id, module.provenance.origin]),
      [
        ["booking", "declared"],
        ["calendar", "declared"],
        ["src", "inferred"],
      ],
    );
    assert.deepEqual(
      snapshot.architecture.contracts.map((contract) => contract.id),
      ["calendar:event:reserved", "calendar:query:availability"],
    );
    assert.deepEqual(
      snapshot.architecture.interactions.map((interaction) => [interaction.kind, interaction.from, interaction.to]),
      [
        ["event", "calendar", "booking"],
        ["query", "booking", "calendar"],
      ],
    );
    assert.equal(snapshot.analysis.dependencyConformance[0]?.status, "confirmed");
    assert.equal(snapshot.source.imports.filter((edge) => edge.purpose === "architecture-declaration").length, 3);
    assert.equal(snapshot.architecture.moduleEdges.length, 1);
    assert.equal(snapshot.analysis.cycles.length, 0);
    assert.match(renderInteractionGraphDot(snapshot), /"calendar" -> "booking"/);
  } finally {
    project.cleanup();
  }
});

test("rejects non-literal architecture declaration syntax with a source location", () => {
  const project = createProject({
    files: {
      "src/a/index.ts": "export const a = true;\n",
      "src/a/module.arch.ts":
        'import { defineModule } from "@arch-inspector/contracts";\nconst id = "a";\nexport const A = defineModule({ id });\n',
    },
  });
  try {
    assert.throws(
      () => analyzeProject(project.root),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_ARCHITECTURE_DECLARATION" &&
        error.message.includes("module.arch.ts:3"),
    );
  } finally {
    project.cleanup();
  }
});
