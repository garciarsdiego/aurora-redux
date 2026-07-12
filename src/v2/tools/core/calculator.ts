// Deterministic arithmetic evaluator (no `eval`), extracted from
// tools/core/index.ts to keep the index to orchestration + trivial tools —
// mirrors the sibling-module pattern already used by web-fetch.ts, grep.ts,
// glob.ts and apply-patch.ts (side-effect import at the top of index.ts).

import { z } from 'zod';
import { registerTool, type ToolResult } from '../registry.js';
import { assertToolEnabled } from './tool-policy.js';

class CalculatorParser {
  private cursor = 0;

  constructor(private readonly source: string) {}

  parse(): number {
    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.cursor !== this.source.length) {
      throw new Error(`calculator: unexpected token at ${this.cursor}`);
    }
    if (!Number.isFinite(value)) throw new Error('calculator: result is not finite');
    return value;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
  }

  private match(char: string): boolean {
    this.skipWhitespace();
    if (this.source[this.cursor] !== char) return false;
    this.cursor += 1;
    return true;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      if (this.match('+')) value += this.parseTerm();
      else if (this.match('-')) value -= this.parseTerm();
      else return value;
    }
  }

  private parseTerm(): number {
    let value = this.parsePower();
    while (true) {
      if (this.match('*')) value *= this.parsePower();
      else if (this.match('/')) {
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error('calculator: division by zero');
        value /= divisor;
      } else if (this.match('%')) {
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error('calculator: modulo by zero');
        value %= divisor;
      } else return value;
    }
  }

  private parsePower(): number {
    const left = this.parseUnary();
    if (!this.match('^')) return left;
    return left ** this.parsePower();
  }

  private parseUnary(): number {
    if (this.match('+')) return this.parseUnary();
    if (this.match('-')) return -this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    if (this.match('(')) {
      const value = this.parseExpression();
      if (!this.match(')')) throw new Error('calculator: missing closing parenthesis');
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.cursor;
    if (this.source[this.cursor] === '.') this.cursor += 1;
    while (/\d/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
    if (this.source[this.cursor] === '.') {
      this.cursor += 1;
      while (/\d/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
    }
    if (this.source[this.cursor] === 'e' || this.source[this.cursor] === 'E') {
      this.cursor += 1;
      if (this.source[this.cursor] === '+' || this.source[this.cursor] === '-') this.cursor += 1;
      while (/\d/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
    }
    const raw = this.source.slice(start, this.cursor);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
      throw new Error(`calculator: expected number at ${start}`);
    }
    return Number(raw);
  }
}

function evaluateCalculatorExpression(expression: string): number {
  if (!/^[\d\s+\-*/%^().eE]+$/.test(expression)) {
    throw new Error('calculator: expression may only contain numbers, operators and parentheses');
  }
  return new CalculatorParser(expression).parse();
}

registerTool({
  name: 'calculator',
  description: 'Evaluate a deterministic arithmetic expression without eval.',
  argsSchema: z.object({
    expression: z.string().min(1).max(500),
    precision: z.number().int().min(0).max(12).optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    assertToolEnabled('calculator', ctx);
    try {
      const result = evaluateCalculatorExpression(args.expression);
      const output = typeof args.precision === 'number'
        ? Number(result.toFixed(args.precision))
        : result;
      return {
        success: true,
        output: JSON.stringify({
          expression: args.expression,
          result: output,
        }),
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
