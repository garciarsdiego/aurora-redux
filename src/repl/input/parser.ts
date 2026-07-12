// Slash command parser — tokenizes input respecting both double and single quotes,
// `\"` and `\'` escape sequences inside double-quoted strings, and shell-style flags.
// Returns a discriminated ParseResult union for the REPL dispatch layer.
// See docs/plans/REPL-LEVEL-D.md § 6 and D-H2.022.

export type ParseResult =
  | { kind: 'slash'; command: string; args: readonly string[] }
  | { kind: 'bash'; command: string }
  | { kind: 'objective'; text: string }
  | { kind: 'noop'; warning?: string };

export class ParseError extends SyntaxError {
  constructor(message: string, public readonly column: number) {
    super(`${message} (column ${column + 1})`);
    this.name = 'ParseError';
  }
}

/**
 * Tokenize a string honoring double and single quoted segments.
 *
 * Rules:
 *   - Double quotes "..." support `\"` and `\\` escape sequences.
 *   - Single quotes '...' are literal — no escapes inside (shell-style).
 *   - Whitespace separates tokens outside quotes.
 *   - Quotes can be embedded inside tokens (foo"bar baz" yields one token `foobar baz`).
 *
 * Throws {@link ParseError} on unterminated quoted strings, with the column of the
 * opening quote so callers can render a useful diagnostic.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;
  let quoteOpenCol = -1;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i += 2;
          continue;
        }
      }
      if (ch === '"') {
        inDouble = false;
        quoteOpenCol = -1;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        quoteOpenCol = -1;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // Outside quotes
    if (ch === '"') {
      inDouble = true;
      quoteOpenCol = i;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      quoteOpenCol = i;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (inDouble || inSingle) {
    const which = inDouble ? 'double' : 'single';
    throw new ParseError(`Unterminated ${which}-quoted string`, quoteOpenCol);
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Parse a raw REPL input line into a typed ParseResult.
 *
 * Rules:
 *   - empty / whitespace-only         → noop
 *   - starts with `/`                 → slash (command + args tokenized)
 *   - bare `/` with no command name   → noop with warning
 *   - starts with `!`                 → bash (rest of line verbatim after `!`)
 *   - anything else                   → objective (preserves internal newlines)
 *
 * Multi-line input (text containing `\n`) is preserved as-is for objective kind so
 * users can paste multi-line briefs. Slash and bash modes operate on the trimmed
 * single-line form because tokens cannot span newlines in those modes.
 */
export function parseInput(line: string): ParseResult {
  // Trimmed view used to detect prefix and tokenize. trim() only removes outer
  // whitespace, so internal newlines survive for multi-line objectives.
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return { kind: 'noop' };
  }

  if (trimmed.startsWith('/')) {
    const withoutSlash = trimmed.slice(1);
    const tokens = tokenize(withoutSlash);

    if (tokens.length === 0) {
      // bare `/` with no command name — surface a warning so the dispatcher
      // can render a helpful hint like "type /help to list commands".
      return { kind: 'noop', warning: 'Empty slash command — type /help to see available commands.' };
    }

    const [command, ...args] = tokens;
    return { kind: 'slash', command: command.toLowerCase(), args };
  }

  if (trimmed.startsWith('!')) {
    // Preserve everything after the first '!' verbatim, including any leading
    // whitespace on the original line that came after the bang.
    const idx = line.indexOf('!');
    const command = line.slice(idx + 1);
    return { kind: 'bash', command };
  }

  // Objective: internal newlines are preserved so pasted briefs survive intact.
  return { kind: 'objective', text: trimmed };
}
