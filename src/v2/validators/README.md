# src/v2/validators/

**Status (Sprint 11, D-H2.066):** wired. Não é stub.

4 perfis de validador heurístico que rodam em `executor/consolidation.ts` para emitir aviso quando output final não bate com o tipo esperado.

## Exports (`index.ts`)

| Export | Propósito |
|---|---|
| `ValidatorResult` (`{passed, message}`) | Retorno padrão |
| `ValidatorFn` (`(output: string) => ValidatorResult`) | Signature |
| `ValidatorProfile` (`'code' \| 'content' \| 'data' \| 'analysis' \| 'none'`) | Enum |
| `validateCode`, `validateContent`, `validateData`, `validateAnalysis` | 4 implementações |
| `getValidator(profile)` | Resolve profile → fn |

## Profiles (quando cada um dispara)

| Profile | Consumidor típico | Heurística |
|---|---|---|
| `code` | DAG kind=`cli_spawn` rodando Codex/Codex/Gemini | Detecta blocos de código, syntax básica |
| `content` | DAG kind=`llm_call` com objetivo de redação | Detecta texto coerente sem placeholders |
| `data` | DAG kind=`llm_call` com objetivo de extração | Detecta JSON/CSV-like strutura |
| `analysis` | DAG kind=`llm_call` com objetivo de análise | Detecta estrutura argumentativa |
| `none` | Bypass | `getValidator('none')` retorna `null` |

## Consumidores

- `src/brain/executor/consolidation.ts:7` — `getValidator(profile)` no path de consolidation final do workflow

## Tests

`tests/unit/validators.test.ts` cobre os 4 profiles com fixtures positivas/negativas.
