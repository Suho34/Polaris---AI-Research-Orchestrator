import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * 100% Safe, Sandboxed Mathematical Expression Parser.
 * Uses recursive-descent evaluation without eval() or new Function().
 */

type Token =
  | { type: "number"; value: number }
  | { type: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
  | { type: "paren"; value: "(" | ")" }
  | { type: "comma" }
  | { type: "ident"; value: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && i + 1 < expr.length && /[0-9]/.test(expr[i + 1]))) {
      // Strict number literal: digits with at most one decimal point.
      // (The old /[0-9.]/ loop accepted "1..2" and silently parsed it as 1.)
      const rest = expr.slice(i);
      const m = rest.match(/^\d+(\.\d+)?|\.\d+/);
      if (!m) throw new Error(`Invalid number starting at '${rest.slice(0, 10)}'`);
      const numStr = m[0];
      i += numStr.length;
      const num = parseFloat(numStr);
      if (isNaN(num)) throw new Error(`Invalid number: '${numStr}'`);
      tokens.push({ type: "number", value: num });
      continue;
    }

    if ("+-*/%^".includes(ch)) {
      tokens.push({ type: "op", value: ch as "+" | "-" | "*" | "/" | "%" | "^" });
      i++;
      continue;
    }

    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i++;
      continue;
    }

    if (ch === ",") {
      tokens.push({ type: "comma" });
      i++;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let ident = "";
      while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i])) {
        ident += expr[i++];
      }
      tokens.push({ type: "ident", value: ident });
      continue;
    }

    throw new Error(`Unexpected character in math expression: '${ch}'`);
  }

  return tokens;
}

const ALLOWED_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  pow: Math.pow,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  min: Math.min,
  max: Math.max,
};

const ALLOWED_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

class MathParser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error("Unexpected end of expression");
    return t;
  }

  public parse(): number {
    const res = this.parseExpression();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token after expression: '${JSON.stringify(this.tokens[this.pos])}'`);
    }
    return res;
  }

  // Expression = Additive
  private parseExpression(): number {
    return this.parseAdditive();
  }

  // Additive = Multiplicative (('+' | '-') Multiplicative)*
  private parseAdditive(): number {
    let left = this.parseMultiplicative();
    while (true) {
      const next = this.peek();
      if (next && next.type === "op" && (next.value === "+" || next.value === "-")) {
        this.consume();
        const right = this.parseMultiplicative();
        left = next.value === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  // Multiplicative = Power (('*' | '/' | '%') Power)*
  private parseMultiplicative(): number {
    let left = this.parsePower();
    while (true) {
      const next = this.peek();
      if (next && next.type === "op" && (next.value === "*" || next.value === "/" || next.value === "%")) {
        this.consume();
        const right = this.parsePower();
        if ((next.value === "/" || next.value === "%") && right === 0) {
          throw new Error("Division by zero");
        }
        if (next.value === "*") left = left * right;
        else if (next.value === "/") left = left / right;
        else left = left % right;
      } else {
        break;
      }
    }
    return left;
  }

  // Power = Unary ('^' Power)* (right-associative)
  private parsePower(): number {
    const base = this.parseUnary();
    const next = this.peek();
    if (next && next.type === "op" && next.value === "^") {
      this.consume();
      const exp = this.parsePower();
      return Math.pow(base, exp);
    }
    return base;
  }

  // Unary = ('+' | '-') Unary | Primary
  private parseUnary(): number {
    const next = this.peek();
    if (next && next.type === "op" && (next.value === "+" || next.value === "-")) {
      this.consume();
      const val = this.parseUnary();
      return next.value === "-" ? -val : val;
    }
    return this.parsePrimary();
  }

  // Primary = Number | Identifier ['(' Args ')'] | '(' Expression ')'
  private parsePrimary(): number {
    const t = this.consume();

    if (t.type === "number") {
      return t.value;
    }

    if (t.type === "paren" && t.value === "(") {
      const val = this.parseExpression();
      const closing = this.consume();
      if (closing.type !== "paren" || closing.value !== ")") {
        throw new Error("Missing closing parenthesis ')'");
      }
      return val;
    }

    if (t.type === "ident") {
      // Normalize identifier (strip 'Math.' prefix and lowercase)
      let cleanIdent = t.value;
      if (cleanIdent.startsWith("Math.") || cleanIdent.startsWith("math.")) {
        cleanIdent = cleanIdent.slice(5);
      }
      const lower = cleanIdent.toLowerCase();

      // Check if constant (e.g. PI, E)
      const isParenNext = this.peek()?.type === "paren" && (this.peek() as { type: "paren"; value: string }).value === "(";
      if (lower in ALLOWED_CONSTANTS && !isParenNext) {
        return ALLOWED_CONSTANTS[lower];
      }

      // Check if function
      if (lower in ALLOWED_FUNCTIONS) {
        const next = this.peek();
        if (!next || next.type !== "paren" || next.value !== "(") {
          throw new Error(`Function '${t.value}' must be followed by parentheses '()'`);
        }
        this.consume(); // consume '('

        const args: number[] = [];
        const nextArg = this.peek();
        if (nextArg?.type !== "paren" || nextArg.value !== ")") {
          while (true) {
            args.push(this.parseExpression());
            const afterArg = this.peek();
            if (afterArg && afterArg.type === "comma") {
              this.consume();
            } else {
              break;
            }
          }
        }

        const closing = this.consume();
        if (closing.type !== "paren" || closing.value !== ")") {
          throw new Error(`Missing closing parenthesis ')' for function '${t.value}'`);
        }

        const fn = ALLOWED_FUNCTIONS[lower];
        return fn(...args);
      }

      throw new Error(`Unsupported identifier or blocked function: '${t.value}'`);
    }

    throw new Error(`Unexpected token: ${JSON.stringify(t)}`);
  }
}

export function evaluateSafeMath(expression: string): number {
  const MAX_EXPRESSION_CHARS = 2000;
  const trimmed = expression.trim();
  if (trimmed.length === 0) throw new Error("Expression is empty");
  if (trimmed.length > MAX_EXPRESSION_CHARS) {
    throw new Error(`Expression too long (${trimmed.length} chars, max ${MAX_EXPRESSION_CHARS})`);
  }
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) throw new Error("Expression is empty");
  if (tokens.length > 500) throw new Error("Expression too complex (max 500 tokens)");
  const parser = new MathParser(tokens);
  const result = parser.parse();
  if (!Number.isFinite(result)) {
    throw new Error("Expression evaluated to non-finite value (NaN or Infinity)");
  }
  return result;
}

export default defineTool({
  description:
    "Perform a mathematical calculation from an expression. Safe, deterministic evaluator for arithmetic (+, -, *, /, %, ^), formulas, and standard math functions (sqrt, pow, abs, round, sin, cos, tan, exp, log, min, max, PI, E).",
  inputSchema: z.object({
    expression: z.string().min(1).max(2000).describe("Math expression to evaluate, e.g. '12 * 4.5 + 3', 'Math.sqrt(16)', or '(100 - 25) / 5'"),
  }),
  async execute({ expression }) {
    try {
      const result = evaluateSafeMath(expression);
      return { expression: expression.slice(0, 200), result };
    } catch (err) {
      // Truncate: the raw expression can be KBs of pasted junk — don't echo it all into logs.
      throw new Error(`Failed to evaluate expression '${expression.slice(0, 200)}': ${(err as Error).message}`);
    }
  },
});
