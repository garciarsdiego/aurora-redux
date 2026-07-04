"""Analyze a Kimi wire.jsonl session for tool_call vs prose patterns."""
import json
import sys

fp = sys.argv[1] if len(sys.argv) > 1 else None
if not fp:
    print("usage: python analyze-kimi-session.py <wire.jsonl>")
    sys.exit(1)

tool_calls = 0
tool_results = 0
errors = 0
prose_blocks = 0
edit_attempts = []
edit_errors = []
all_tool_names = {}

with open(fp, 'r', encoding='utf-8') as f:
    for line in f:
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        msg = e.get('message', {})
        mt = msg.get('type', '')
        if mt == 'ToolCall':
            tool_calls += 1
            fn = msg.get('payload', {}).get('function', {})
            name = fn.get('name', '')
            args_str = fn.get('arguments', '')
            all_tool_names[name] = all_tool_names.get(name, 0) + 1
            if name in ('Edit', 'Write', 'Replace') or 'src/v2/advisors' in args_str:
                edit_attempts.append(f'{name}({args_str[:120]})')
        elif mt == 'ToolResult':
            tool_results += 1
            rv = msg.get('payload', {}).get('return_value', {})
            if rv.get('is_error'):
                errors += 1
                err = rv.get('output', '')[:400]
                edit_errors.append(err)
        elif mt == 'ContentPart' and msg.get('payload', {}).get('type') == 'text':
            prose_blocks += 1

print(f'tool_calls={tool_calls} results={tool_results} errors={errors} prose_blocks={prose_blocks}')
print(f'tool_names: {all_tool_names}')
print()
print(f'edit_attempts (first 8):')
for ea in edit_attempts[:8]:
    print(f'  {ea}')
print()
print(f'edit_errors (first 5):')
for ee in edit_errors[:5]:
    print(f'  {ee[:300]}')
    print('  ---')
