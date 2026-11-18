# WeldPanel SQL corpus

`sql-corpus.json` holds every kind of SQL statement WeldPanel sends to Basin
SQL (Apache DataFusion). It also holds the input that produced each statement
the query compiler writes. The Rust backend uses it in two ways:

- a DataFusion test plans and runs every statement over the Iceberg tables
  (with `datafusion-functions-json` registered);
- the Rust port of the compiler compiles every `compiler` entry's input and
  compares the text with `sql` byte for byte.

## Format

```json
{
  "version": 1,
  "entries": [
    {
      "id": "query/trends/math-sum",
      "source": "compiler",
      "input": { "call": "runPanelQuery", "context": { … }, "spec": { … }, "responses": { … } },
      "statements": [{ "name": "trends.series", "sql": "SELECT …", "columns": ["bucket", "s0_v"] }]
    }
  ]
}
```

- `statements` are listed in the order they are sent. `columns` are the
  aliases the statement selects, in order.
- `source: "compiler"`: the statements come from `@weldsuite/panel-domain/query`.
  `input` is everything needed to compile them again. Its object keys are
  sorted, and every default is filled in: parsing `input` again with
  `corpusInputSchema` (in `corpus.ts`) changes nothing.
- `source: "panel-api"`: statements that panel-api writes itself
  (`apps/workers/panel-api/src/services/<file>`, named in the `id`), rebuilt in
  `panel-api.ts` from the same helpers. `input` is `null`. The names
  `usage.events` and `usage.recordings` are labels used only in this corpus,
  because panel-api sends those two statements without a name.

Ids are `<group>/<kind>/<variant>[@context]`, sorted. The `isolation-*` entries
are the specs from `compile.test.ts`, each run under three contexts: identified,
anonymous and erased.

## Inputs (`input.call`)

All of them take `context`, a `PanelQueryContext` written as JSON.
`context.now` is the frozen clock as an ISO 8601 UTC string; every case uses
`2026-11-14T12:00:00.000Z`. Time zone offsets come from the IANA database, at
the end of the range.

| `call` | Compiles | Other fields |
|---|---|---|
| `runPanelQuery` | `runPanelQuery(spec, context, executor)` | `spec`: a parsed `panelQuerySpecSchema`. `responses`: rows by statement name. Some runners read a result before they write the next statement: breakdown ranges and values, signal candidates, the sessions page. A statement with no entry in `responses` gets no rows. |
| `activityQuery` | `activityQuery(context, options)` | `options` |
| `activityCountQuery` | `activityCountQuery(context, distinctId, days)` | `distinctId`, `days` |
| `lexiconQueries` | `lexiconQueries(context)` | |
| `exportPageQuery` | `exportPageQuery(context, page)` | `page`, with `from` and `to` as ISO 8601 instants |
| `explain` | panel-api's root cause (`explainNumbers`) | `request`: a parsed `explainPanelChangeSchema`. The steps: drop `breakdown`, `breakdowns`, `formulas` and `formulaOnly` from `request.spec`, then run `resolveRange`, `explainWindows` (at `trendsInterval`), `explainDimensions` and `explainQueries`. |

## Regenerating

`corpus.test.ts` rebuilds the corpus from `cases.ts` and fails when the file is
stale. The failure lists the ids that are new, removed or changed. To rewrite
the file:

```bash
UPDATE_SQL_CORPUS=1 pnpm --filter @weldsuite/panel-domain test corpus
```

In PowerShell, run `$env:UPDATE_SQL_CORPUS=1` first.

Commit the JSON with the compiler change that caused it. The Rust tests read
the committed file.

To cover a new branch, add a case to `cases.ts`. If panel-api changes one of
the statements it writes itself, change the matching builder in
`panel-api.ts`.
