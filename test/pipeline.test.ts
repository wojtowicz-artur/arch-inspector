import assert from "node:assert/strict";
import test from "node:test";
import {
  collectProvider,
  FactStore,
  type AnalysisContext,
  type FactProvider,
  type Projector,
} from "../src/pipeline.js";

test("keeps versioned fact batches ordered, append-only and isolated", () => {
  const store = new FactStore();
  const facts = ["z-fact"];

  store.add("contracts", {
    source: { id: "z-provider", version: "1.0.0" },
    facts,
  });
  store.add("contracts", {
    source: { id: "a-provider", version: "1.0.0" },
    facts: ["a-fact"],
  });
  facts.push("not-stored");

  assert.deepEqual(
    store.batches<string>("contracts").map((batch) => batch.source),
    [
      { id: "a-provider", version: "1.0.0" },
      { id: "z-provider", version: "1.0.0" },
    ],
  );
  assert.deepEqual(store.facts<string>("contracts"), ["a-fact", "z-fact"]);
  assert.throws(
    () =>
      store.add("contracts", {
        source: { id: "a-provider", version: "1.0.0" },
        facts: ["duplicate"],
      }),
    /already supplied/,
  );
});

test("provider collection requires matching source metadata", () => {
  const store = new FactStore();
  const provider: FactProvider<string> = {
    id: "test/provider",
    version: "0.1.0",
    factKind: "test.facts",
    collect: () => ({
      source: { id: "test/provider", version: "0.1.0" },
      facts: ["ok"],
    }),
  };

  collectProvider(store, provider, {} as AnalysisContext);
  assert.deepEqual(store.facts<string>("test.facts"), ["ok"]);

  const invalidProvider: FactProvider<string> = {
    ...provider,
    id: "test/invalid-provider",
    collect: () => ({
      source: { id: "test/provider", version: "0.1.0" },
      facts: ["wrong-source"],
    }),
  };
  assert.throws(
    () => collectProvider(store, invalidProvider, {} as AnalysisContext),
    /returned mismatched source metadata/,
  );
});

test("projectors are explicit pure transformations", () => {
  const projector: Projector<readonly number[], number[]> = {
    id: "test/sorted-values",
    version: "0.1.0",
    project: (values) => [...values].sort((left, right) => left - right),
  };
  const input = Object.freeze([3, 1, 2]);

  assert.deepEqual(projector.project(input), [1, 2, 3]);
  assert.deepEqual(input, [3, 1, 2]);
});
