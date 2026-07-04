"""Show full paths Kimi attempted to write to."""
import json
import sys

fp = sys.argv[1] if len(sys.argv) > 1 else None
if not fp:
    sys.exit(1)

with open(fp, 'r', encoding='utf-8') as f:
    for line in f:
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        msg = e.get('message', {})
        if msg.get('type') == 'ToolCall':
            fn = msg.get('payload', {}).get('function', {})
            name = fn.get('name', '')
            if name in ('WriteFile', 'StrReplaceFile'):
                args_raw = fn.get('arguments', '')
                try:
                    args = json.loads(args_raw)
                    print(f'{name}: path={args.get("path", "?")}')
                except Exception:
                    print(f'{name}: {args_raw[:200]}')
