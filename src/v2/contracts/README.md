# src/v2/contracts/

**Status (Sprint 11, D-H2.066):** wired. Não é stub.

Contratos tipados para upstream selectors do executor — permite tasks downstream extraírem subsets do output upstream sem reinterpretar JSON manualmente.

## Exports

| Arquivo | Export | Propósito |
|---|---|---|
| `apply-selectors.ts` | `SelectorValue` (`string[] \| 'summary_only' \| 'raw_full'`), `ApplySelectorResult`, `applySelector(upstream, selector)` | Aplica selector a output upstream |

## Consumidores

- `src/brain/executor/run-task.ts:8` — type-only import de `SelectorValue`
- `src/brain/executor/upstream.ts:4` — `applySelector` + `SelectorValue` runtime
- `src/brain/executor/types.ts:2` — type-only import

## Tests

`tests/unit/contracts.test.ts` cobre `applySelector`.
