#!/usr/bin/env bash
# Usage:
#   bash scripts/find-pt-comments.sh
#   bash scripts/find-pt-comments.sh --json | jq '.'
#
# Generated via Omniroute (if/deepseek-v3.2). Scans src/ + apps/dashboard-v2/src/
# for comment lines containing common Portuguese words to triage which files
# still need the EN translation pass (audit §4 baixos).

set -euo pipefail

JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

SEARCH_DIRS=("src/" "apps/dashboard-v2/src/")
EXCLUDE_DIRS_RE="(node_modules|/dist/|/\.git/|/data/|/workspaces/|\.claude/worktrees)"

# Distinctive PT words. Skip common English false positives (para/como/que/etc.).
PT_WORDS="são|está|este|esta|esse|essa|foi|ações|executar|tarefa|tarefas|configuração|configurações|criar|alterar|garantir|verificar|próximo|próxima|primeiro|primeira|último|última|antes|depois|então|sempre|nunca|nenhum|todos|todas|agora|mesmo|mesma|ambos|ambas|ainda|apenas|somente|deve|devem|faltam|falta|falhou|falhar|sucesso"

# Match a comment marker followed by content containing a PT word
COMMENT_AND_PT="(//|/\*|\*)[^\"']*\b(${PT_WORDS})\b"

declare -A FILE_COUNTS
declare -a MATCHES

while IFS= read -r raw; do
  [[ -z "$raw" ]] && continue
  file="${raw%%:*}"
  rest="${raw#*:}"
  lineno="${rest%%:*}"
  text="${rest#*:}"
  snippet="${text:0:100}"

  FILE_COUNTS["$file"]=$(( ${FILE_COUNTS["$file"]:-0} + 1 ))
  MATCHES+=("${file}|${lineno}|${snippet}")
done < <(
  for dir in "${SEARCH_DIRS[@]}"; do
    [[ -d "$dir" ]] || continue
    grep -rn -E --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" \
      -i "${COMMENT_AND_PT}" "$dir" 2>/dev/null \
      | grep -Ev "${EXCLUDE_DIRS_RE}" || true
  done
)

if $JSON_MODE; then
  printf '['
  first=true
  for entry in "${MATCHES[@]}"; do
    file="${entry%%|*}"
    rest="${entry#*|}"
    lineno="${rest%%|*}"
    text="${rest#*|}"
    text_escaped="${text//\\/\\\\}"
    text_escaped="${text_escaped//\"/\\\"}"
    text_escaped="${text_escaped//$'\t'/\\t}"
    text_escaped="${text_escaped//$'\n'/\\n}"
    if $first; then first=false; else printf ','; fi
    printf '\n  {"file":"%s","line":%s,"text":"%s"}' "$file" "$lineno" "$text_escaped"
  done
  printf '\n]\n'
else
  current_file=""
  for entry in "${MATCHES[@]}"; do
    file="${entry%%|*}"
    rest="${entry#*|}"
    lineno="${rest%%|*}"
    text="${rest#*|}"
    if [[ "$file" != "$current_file" ]]; then
      [[ -n "$current_file" ]] && printf '\n'
      printf '=== %s (%d match(es)) ===\n' "$file" "${FILE_COUNTS[$file]}"
      current_file="$file"
    fi
    printf '%s:%s: %s\n' "$file" "$lineno" "$text"
  done

  printf '\n--- Summary ---\n'
  total=0
  for f in "${!FILE_COUNTS[@]}"; do
    total=$(( total + FILE_COUNTS[$f] ))
  done
  for f in "${!FILE_COUNTS[@]}"; do
    printf '%4d  %s\n' "${FILE_COUNTS[$f]}" "$f"
  done | sort -rn
  printf '%4d  TOTAL\n' "$total"
fi
