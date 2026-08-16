# arch-inspector

Pierwszy eksperymentalny slice toolingu do obserwowania ewolucji architektury TypeScript.

## MVP 0.3

Inspector nie wymaga adnotacji w analizowanym kodzie. Czyta istniejące `tsconfig.json`, wykorzystuje TypeScript Compiler API do rozwiązywania importów i emituje deterministyczny Architecture IR:

- automatyczne moduły na podstawie `src/modules`, `src/features`, `src/app`, `src/shared` lub konfiguracji; kolizyjne nazwy są namespacowane względną ścieżką, np. `features/auth` i `modules/auth`;
- import graph z obsługą aliasów `paths`, barrel files i package resolution;
- importy static, export-from, dynamic `import()` i proste `require()`;
- rozróżnienie importów internal/external/unresolved oraz type-only;
- module graph, cykle, fan-in/fan-out;
- wykrywanie deep imports względem `index.ts` modułu;
- deterministyczny JSON z wersjonowanym `irVersion` i snapshot receipt;
- deklaratywny katalog reguł `noCycles`, `noDeepImports` i jawnych zakazanych zależności.

Snapshot ma trzy warstwy:

- `source.files` i `source.imports` — fakty zaobserwowane w plikach i resolverze;
- `architecture.modules`, `architecture.ownership` i `architecture.moduleEdges` — projekcja granic modułów;
- `analysis.cycles`, `analysis.metrics` i `analysis.findings` — wyniki algorytmów i reguł.

Każdy fakt ma `provenance` z pochodzeniem (`observed`, `declared`, `inferred` albo
`derived`) oraz opcjonalnym evidence. Receipt zawiera `snapshotId`, wersję
narzędzia, hash konfiguracji, opcji kompilatora i wejścia.

## Architecture Diff 0.3

Diff porównuje snapshot z aktualnym working tree albo z refem Git. To porównanie jest oparte o stabilne identyfikatory modułów, plików i krawędzi, więc zmiana numeru linii sama w sobie nie tworzy nowej zależności.

```bash
# najpierw wygeneruj bazowy snapshot
node dist/src/cli.js inspect . --out architecture-baseline.json

# porównaj snapshot z bieżącym kodem
node dist/src/cli.js diff architecture-baseline.json .

# albo porównaj z commitem/branchem Git (bez zmiany worktree)
node dist/src/cli.js diff main .

# jawnie włącz politykę failowania w CI
node dist/src/cli.js diff main . --check
node dist/src/cli.js diff main . --check --fail-on cycles,deep-imports
```

Diff pokazuje dodane/usunięte moduły, ownership plików, importy, zależności,
cykle, findings oraz zmiany metryk. Snapshoty z inną konfiguracją lub opcjami
kompilatora są odrzucane jako nieporównywalne. `hasRegressions` jest `true`, gdy
pojawił się nowy cykl albo nowe naruszenie reguły.

## Uruchomienie

```bash
npm install
npm test
npm run build
npm run format:check
npm run lint
npm run quality
node dist/src/cli.js inspect ../ścieżka/do/projektu
node dist/src/cli.js inspect ../ścieżka/do/projektu --json --out architecture.json
node dist/src/cli.js graph ../ścieżka/do/projektu --out architecture.dot
node dist/src/cli.js check ../ścieżka/do/projektu
node dist/src/cli.js check ../ścieżka/do/projektu --fail-on cycles,deep-imports
node dist/src/cli.js diff main ../ścieżka/do/projektu --check
```

`arch check` jest report-only, jeśli nie podano `--fail-on` i projekt nie ma
polityki `failOn` w konfiguracji. `--check` przy `arch diff` jest jawnym żądaniem
failowania na wprowadzonych naruszeniach; brak porównywalności kończy się kodem
wyjścia `3`.

Formatowanie zapewnia Oxfmt (`npm run format`), a lintowanie Oxlint
(`npm run lint`). Konfiguracje znajdują się w `.oxfmtrc.json` i
`.oxlintrc.json`; zakres narzędzi obejmuje `src` oraz `test`.

Konfiguracja projektu, snapshoty IR i deklaracje `RuleSpec` są walidowane
runtime przez Zod. Analyzer waliduje również snapshot przed zwróceniem go do
konsumenta, a receipt jest sprawdzany przy zapisie/odczycie. Błędy na tych
granicach zawierają ścieżkę do niepoprawnego pola zamiast cichego rzutowania
danych. Przykładowy kontrakt IR 0.3 znajduje się w
`test/fixtures/architecture-0.3.json`. Polityka IR 0.3 jest jawnie `exact`:
receipt jest wymagany, a nieznane pola są odrzucane; kolejna wersja będzie
wymagała osobnego adaptera/migracji.

`arch graph` emituje deterministyczny graf modułów w formacie Graphviz DOT. Węzły
uczestniczące w cyklu są wyróżnione, a etykiety krawędzi pokazują liczbę
importów i udział importów przez publiczne API. Flaga `--json` zachowuje pełny
snapshot IR zamiast formatu DOT.

Konfiguracja opcjonalna: `arch.config.json` w katalogu projektu:

```json
{
  "include": ["src/**"],
  "exclude": ["src/legacy/**"],
  "moduleIdStrategy": "compact",
  "modules": {
    "booking": {
      "root": "src/modules/booking",
      "publicEntrypoints": ["src/modules/booking/public-api.ts"]
    }
  },
  "noCycles": true,
  "noDeepImports": true,
  "failOn": ["cycles", "deep-imports"],
  "forbiddenDependencies": [
    { "from": "admin", "to": "infrastructure" }
  ],
  "rules": [
    {
      "code": "project/internal-import",
      "source": "imports",
      "where": [{ "field": "isInternal", "operator": "eq", "value": true }],
      "finding": {
        "category": "observation",
        "level": "info",
        "message": "${fromModule} imports ${toModule}.",
        "file": { "field": "fromFile" }
      }
    }
  ]
}
```

Silnik reguł nie rozgałęzia się po kodach reguł. Reguły są specyfikacjami
`RuleSpec`: wybierają kolekcję znormalizowanych faktów, nakładają predykaty i
mapują rekord na finding. Katalog wbudowany można rozszerzyć przez pole `rules`
w `arch.config.json` albo programowo przez `evaluateRules(input, [...])`.
Reguła musi wskazywać znaną kolekcję (`cycles`, `imports`,
`forbiddenDependencies` albo `modules`), a kody reguł muszą być unikalne.
`rules` jest skrótem dla lokalnego packa; dla jawnego kontraktu użyj
`rulePacks` z polami `id`, `version`, `requiredFacts` i `rules`.
`compact` zachowuje krótkie ID dla unikalnych modułów i namespacuje tylko
kolizje; `relative-path` używa ścieżek względnych dla wszystkich modułów
inferowanych. Jawnie zadeklarowane moduły zawsze zachowują skonfigurowane ID.

Domyślnie inspector pomija artefakty `node_modules`, `.next`, `dist`, `build`, `coverage`, `.turbo` i `.cache`. `include` oraz `exclude` odnoszą się do ścieżek względnych względem katalogu z `tsconfig.json`. `modules` pozwala opisać moduły, które nie mają fizycznego `index.ts`. Importy CSS/SCSS, obrazów i fontów są raportowane jako `asset`, a nie jako błędne `unresolved`.

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
