# Benchmark corpus

The corpus contains small, checked-in projects which exercise the inspector's
stable facts rather than a synthetic micro-benchmark:

- `small` is a minimal inferred module graph;
- `small-type-aware` has the same shape with checker metadata enabled;
- `modular-monolith` combines public APIs, a deep import, a cycle and a
  boundary violation.

Run the benchmark from the repository root:

```bash
npm run benchmark
npm run benchmark -- --iterations 10 --warmup 2 --json
```

The command fails when a corpus invariant disappears. Timings are reported for
performance work, but are intentionally not used as a CI threshold because
they depend on the host machine and TypeScript cache state.
