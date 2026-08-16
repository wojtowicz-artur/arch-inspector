# arch-inspector

Pierwszy eksperymentalny slice toolingu do obserwowania ewolucji architektury TypeScript.

## MVP 0.1

Inspector nie wymaga adnotacji w analizowanym kodzie. Czyta istniejące `tsconfig.json`, wykorzystuje TypeScript Compiler API do rozwiązywania importów i emituje deterministyczny Architecture IR:

- automatyczne moduły na podstawie `src/modules`, `src/features`, `src/app`, `src/shared` lub konfiguracji;
- import graph z obsługą aliasów `paths`, barrel files i package resolution;
- importy static, export-from, dynamic `import()` i proste `require()`;
- rozróżnienie importów internal/external/unresolved oraz type-only;
- module graph, cykle, fan-in/fan-out;
- wykrywanie deep imports względem `index.ts` modułu;
- deterministyczny JSON z wersjonowanym `irVersion`;
- reguły `noCycles`, `noDeepImports` i jawne zakazane zależności.

## Architecture Diff 0.2

Diff porównuje snapshot z aktualnym working tree albo z refem Git. To porównanie jest oparte o stabilne identyfikatory modułów, plików i krawędzi, więc zmiana numeru linii sama w sobie nie tworzy nowej zależności.

```bash
# najpierw wygeneruj bazowy snapshot
node dist/src/cli.js inspect . --out architecture-baseline.json

# porównaj snapshot z bieżącym kodem
node dist/src/cli.js diff architecture-baseline.json .

# albo porównaj z commitem/branchem Git (bez zmiany worktree)
node dist/src/cli.js diff main .

# tryb CI: zakończ kodem 1, jeśli pojawiły się nowe naruszenia/cykle
node dist/src/cli.js diff main . --check
```

Diff pokazuje dodane/usunięte moduły, pliki, zależności, cykle, diagnostyki oraz zmiany metryk. `hasRegressions` jest `true`, gdy pojawił się nowy cykl albo nowe naruszenie reguły.

## Uruchomienie

```bash
npm install
npm test
npm run build
node dist/src/cli.js inspect ../ścieżka/do/projektu
node dist/src/cli.js inspect ../ścieżka/do/projektu --json --out architecture.json
node dist/src/cli.js check ../ścieżka/do/projektu
node dist/src/cli.js diff main ../ścieżka/do/projektu --check
```

Konfiguracja opcjonalna: `arch.config.json` w katalogu projektu:

```json
{
  "moduleRoots": ["src/modules"],
  "noCycles": true,
  "noDeepImports": true,
  "forbiddenDependencies": [
    { "from": "admin", "to": "infrastructure" }
  ]
}
```

To jeszcze nie jest framework ani pełny system kontraktów. IR jest granicą, za którą można później wymienić analyzer, dodać diff Git i jawne deklaracje modułów bez zmiany konsumentów danych.

## Public API

CLI korzysta z tego samego publicznego entrypointu co integracje Node.js:

```ts
import { analyzeProject, diffSnapshots } from "arch-inspector";

const base = analyzeProject(".");
const current = analyzeProject(".");
const diff = diffSnapshots(base, current);
```

Źródło entrypointu znajduje się w `src/index.ts`; `dist/` zawiera wyłącznie wygenerowany JavaScript i deklaracje `.d.ts`.
