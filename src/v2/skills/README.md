# src/v2/skills/

**Status (Sprint 11, D-H2.066):** wired. Não é stub.

Sistema local-first de skills aplicáveis a DAGs. Skills nascem de uso real (≥3 execuções, D-H2.020) — pasta raiz `patterns/` é intencionalmente vazia até dogfood capturar primeiras skills.

## Exports

| Arquivo | Export | Propósito |
|---|---|---|
| `types.ts` | `SkillDefinition`, `SkillMatch` | Tipos compartilhados |
| `parser.ts` | `parseSkillContent(content, filePath?)` | Parse de `.skill.md` (YAML frontmatter + markdown body) |
| `matcher.ts` | `matchSkills(prompt, skills[])` | Score-based matching skill ↔ prompt |
| `registry.ts` | `registerSkill`, `resolveSkill`, `listSkills`, `recordWin`, `getWinCount`, `isCaptured`, `listCapturedSkills`, `_resetRegistry`, `loadSkillsFromDir`, `CAPTURE_THRESHOLD` | In-memory registry + win counter para promoção a "captured" |
| `apply-to-dag.ts` | `applySkillExecutionMode(dag, skill)`, `applyBestSkillExecutionMode(dag, prompt, skills, opts)` | Aplica execution_mode da skill ao DAG planejado |

## Consumidores

- `src/mcp/tools/plan_workflow.ts:10-11` — `loadSkillsFromDir` + `applyBestSkillExecutionMode`
- `src/mcp/tools/run_workflow.ts:20-21` — mesmo

## Tests

`tests/unit/skills.test.ts` cobre parser, matcher, registry, apply-to-dag.

## Sprint 11 ações futuras

- Adicionar test que prova `applyBestSkillExecutionMode` é chamado com skills reais (não apenas array vazio fallback) quando `patterns/*.skill.md` existem.
- Documentar formato `.skill.md` esperado (YAML frontmatter keys + markdown body conventions) num doc dedicado quando primeira skill for capturada via dogfood.
