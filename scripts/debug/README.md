# scripts/debug/

Scripts ad-hoc de diagnóstico/debug. **Não wired no `package.json`** — invocação manual via `node scripts/debug/<arquivo>.mjs`.

| Script | Propósito |
|---|---|
| `_dump-task-output.mjs` | Imprime stdout/stderr completos de uma task pelo ID |
| `_lookup-last-wf.mjs` | Encontra o último workflow_id por workspace |
| `_validate-dag-templates.mjs` | Valida todos os DAG templates em `patterns/` contra Zod |
| `_validate-one-dag.mjs` | Valida um único DAG file (.yaml/.json) |
| `extract-output.mjs` | Extrai output final de um workflow para arquivo |
| `inspect-last-run.mjs` | Pretty-print do último run (events + tasks + outputs) |
| `tail-events.mjs` | Tail real-time de qualquer evento (sem filtro de workflow) |

**Mantidos por D-H2.066 / Sprint 1.5:** úteis para diagnóstico local quando o daemon falha de forma não óbvia ou quando inspeção manual de DAG/output é necessária. Movidos para `debug/` para deixar `scripts/` raiz só com o que tem entrada no `package.json` ou wiring direto.

Se algum script daqui for promovido a comando estável, mover para `scripts/` raiz e wirar em `package.json`. Se ficar 6 meses sem uso, candidato a exclusão em sprint futuro.
