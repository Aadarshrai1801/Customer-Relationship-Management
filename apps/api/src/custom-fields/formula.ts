/**
 * Minimal formula language for custom fields. Hand-written recursive descent —
 * no eval, no external parser. V1 supports same-record refs, arithmetic,
 * comparisons, and CONCAT/ROUND/IF/MIN/MAX. Cross-object refs, date math, and
 * formula-to-formula chaining are explicitly out of scope (see module plan).
 */

export type FormulaValue = number | string | boolean;

export type BinaryOp = '+' | '-' | '*' | '/' | '>' | '<' | '>=' | '<=' | '=' | '!=';
export type FnName = 'CONCAT' | 'ROUND' | 'IF' | 'MIN' | 'MAX';

const BINARY_OPS: BinaryOp[] = ['+', '-', '*', '/', '>', '<', '>=', '<=', '=', '!='];

export type FormulaExpr =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'ref'; key: string }
  | { kind: 'neg'; expr: FormulaExpr }
  | { kind: 'not'; expr: FormulaExpr }
  | { kind: 'binary'; op: BinaryOp; left: FormulaExpr; right: FormulaExpr }
  | { kind: 'logic'; op: 'AND' | 'OR'; items: FormulaExpr[] }
  | { kind: 'call'; name: FnName; args: FormulaExpr[] };

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'ref'; key: string }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

const FUNCTIONS = new Set(['CONCAT', 'ROUND', 'IF', 'MIN', 'MAX']);

function tokenize(
  input: string,
): { ok: true; tokens: Token[] } | { ok: false; error: string; pos: number } {
  const tokens: Token[] = [];
  let i = 0;
  const fail = (error: string): { ok: false; error: string; pos: number } => ({
    ok: false,
    error,
    pos: i,
  });
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const match = /^[0-9]*\.?[0-9]+/.exec(input.slice(i));
      if (!match) return fail('Invalid number');
      tokens.push({ kind: 'num', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const escaped = input[j + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      if (j >= input.length) return fail('Unterminated string literal');
      tokens.push({ kind: 'str', value });
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      const refMatch = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(input.slice(i));
      if (!refMatch) return fail('Invalid field reference (expected {field_key})');
      tokens.push({ kind: 'ref', key: refMatch[1]! });
      i += refMatch[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
      tokens.push({ kind: 'ident', name: ident![0] });
      i += ident![0].length;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (['>=', '<=', '!='].includes(two)) {
      tokens.push({ kind: 'op', op: two });
      i += 2;
      continue;
    }
    if (['+', '-', '*', '/', '>', '<', '='].includes(ch)) {
      tokens.push({ kind: 'op', op: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      i += 1;
      continue;
    }
    return fail(`Unexpected character '${ch}'`);
  }
  return { ok: true, tokens };
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): FormulaExpr {
    const expr = this.orExpr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected trailing input at token ${this.pos + 1}`);
    }
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('Unexpected end of expression');
    this.pos += 1;
    return token;
  }

  private orExpr(): FormulaExpr {
    const items = [this.andExpr()];
    while (this.isKeyword('OR')) {
      this.next();
      items.push(this.andExpr());
    }
    return items.length === 1 ? items[0]! : { kind: 'logic', op: 'OR', items };
  }

  private andExpr(): FormulaExpr {
    const items = [this.notExpr()];
    while (this.isKeyword('AND')) {
      this.next();
      items.push(this.notExpr());
    }
    return items.length === 1 ? items[0]! : { kind: 'logic', op: 'AND', items };
  }

  private isKeyword(word: string): boolean {
    const token = this.peek();
    return token?.kind === 'ident' && token.name.toUpperCase() === word;
  }

  private notExpr(): FormulaExpr {
    if (this.isKeyword('NOT')) {
      this.next();
      return { kind: 'not', expr: this.notExpr() };
    }
    return this.comparison();
  }

  private comparison(): FormulaExpr {
    const left = this.additive();
    const token = this.peek();
    if (token?.kind === 'op' && (BINARY_OPS as string[]).includes(token.op)) {
      const op = token.op;
      if (op === '+' || op === '-' || op === '*' || op === '/') return left;
      this.next();
      const right = this.additive();
      return { kind: 'binary', op: op as BinaryOp, left, right };
    }
    return left;
  }

  private additive(): FormulaExpr {
    let expr = this.multiplicative();
    for (;;) {
      const token = this.peek();
      if (token?.kind === 'op' && (token.op === '+' || token.op === '-')) {
        this.next();
        expr = { kind: 'binary', op: token.op, left: expr, right: this.multiplicative() };
      } else {
        return expr;
      }
    }
  }

  private multiplicative(): FormulaExpr {
    let expr = this.unary();
    for (;;) {
      const token = this.peek();
      if (token?.kind === 'op' && (token.op === '*' || token.op === '/')) {
        this.next();
        expr = { kind: 'binary', op: token.op, left: expr, right: this.unary() };
      } else {
        return expr;
      }
    }
  }

  private unary(): FormulaExpr {
    const token = this.peek();
    if (token?.kind === 'op' && token.op === '-') {
      this.next();
      return { kind: 'neg', expr: this.unary() };
    }
    return this.primary();
  }

  private primary(): FormulaExpr {
    const token = this.next();
    if (token.kind === 'num') return { kind: 'num', value: token.value };
    if (token.kind === 'str') return { kind: 'str', value: token.value };
    if (token.kind === 'ref') return { kind: 'ref', key: token.key };
    if (token.kind === 'lparen') {
      const expr = this.orExpr();
      const closing = this.next();
      if (closing.kind !== 'rparen') throw new Error('Expected closing parenthesis');
      return expr;
    }
    if (token.kind === 'ident') {
      const name = token.name.toUpperCase();
      if (!FUNCTIONS.has(name)) throw new Error(`Unknown function '${token.name}'`);
      const open = this.next();
      if (open.kind !== 'lparen') throw new Error(`Expected ( after ${token.name}`);
      const args: FormulaExpr[] = [];
      if (this.peek()?.kind !== 'rparen') {
        args.push(this.orExpr());
        while (this.peek()?.kind === 'comma') {
          this.next();
          args.push(this.orExpr());
        }
      }
      const closing = this.next();
      if (closing.kind !== 'rparen') throw new Error(`Expected ) to close ${token.name}`);
      return { kind: 'call', name: name as FnName, args };
    }
    throw new Error('Expected a value, field reference, or function call');
  }
}

export function parseFormula(
  input: string,
): { ok: true; ast: FormulaExpr } | { ok: false; error: string } {
  if (!input.trim()) return { ok: false, error: 'Expression is empty' };
  if (input.length > 2000) return { ok: false, error: 'Expression is too long (max 2000 chars)' };
  const tokenized = tokenize(input);
  if (!tokenized.ok)
    return { ok: false, error: `${tokenized.error} at position ${tokenized.pos + 1}` };
  try {
    return { ok: true, ast: new Parser(tokenized.tokens).parse() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function collectRefs(ast: FormulaExpr): string[] {
  const refs = new Set<string>();
  const visit = (node: FormulaExpr): void => {
    if (node.kind === 'ref') refs.add(node.key);
    else if (node.kind === 'neg' || node.kind === 'not') visit(node.expr);
    else if (node.kind === 'binary') {
      visit(node.left);
      visit(node.right);
    } else if (node.kind === 'logic' || node.kind === 'call') {
      const items = node.kind === 'logic' ? node.items : node.args;
      for (const item of items) visit(item);
    }
  };
  visit(ast);
  return [...refs];
}

export type RefResolver = (key: string) => { found: false } | { found: true; value: unknown };

function toNumber(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`${what} must be a number`);
}

function toBoolean(value: unknown, what: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error(`${what} must be true/false`);
}

function display(value: FormulaValue): string {
  return typeof value === 'string' ? value : String(value);
}

function evaluate(node: FormulaExpr, resolve: RefResolver): FormulaValue {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'str':
      return node.value;
    case 'ref': {
      const result = resolve(node.key);
      if (!result.found) throw new Error(`Unknown field {${node.key}}`);
      const value = result.value;
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'object' && value !== null && 'amount' in value) {
        const amount = (value as { amount: unknown }).amount;
        if (typeof amount === 'number' && Number.isFinite(amount)) return amount;
      }
      throw new Error(`Field {${node.key}} has no usable value in formulas`);
    }
    case 'neg':
      return -toNumber(evaluate(node.expr, resolve), 'Negation');
    case 'not':
      return !toBoolean(evaluate(node.expr, resolve), 'NOT');
    case 'binary': {
      const left = evaluate(node.left, resolve);
      const right = evaluate(node.right, resolve);
      switch (node.op) {
        case '+':
        case '-':
        case '*':
        case '/': {
          const a = toNumber(left, 'Left side');
          const b = toNumber(right, 'Right side');
          if (node.op === '+') return a + b;
          if (node.op === '-') return a - b;
          if (node.op === '*') return a * b;
          if (b === 0) throw new Error('Division by zero');
          return a / b;
        }
        case '=':
          return left === right;
        case '!=':
          return left !== right;
        case '>':
        case '<':
        case '>=':
        case '<=': {
          if (typeof left !== 'number' || typeof right !== 'number') {
            throw new Error('Ordering comparisons need numbers on both sides');
          }
          if (node.op === '>') return left > right;
          if (node.op === '<') return left < right;
          if (node.op === '>=') return left >= right;
          return left <= right;
        }
      }
      break;
    }
    case 'logic': {
      const items = node.items.map((item) => toBoolean(evaluate(item, resolve), node.op));
      return node.op === 'AND' ? items.every(Boolean) : items.some(Boolean);
    }
    case 'call': {
      const args = node.args.map((arg) => evaluate(arg, resolve));
      switch (node.name) {
        case 'CONCAT':
          return args.map(display).join('');
        case 'ROUND': {
          if (args.length < 1 || args.length > 2) throw new Error('ROUND needs 1 or 2 arguments');
          const value = toNumber(args[0], 'ROUND value');
          const places = args.length === 2 ? toNumber(args[1], 'ROUND places') : 0;
          if (!Number.isInteger(places) || places < 0 || places > 10) {
            throw new Error('ROUND places must be an integer 0-10');
          }
          const factor = 10 ** places;
          return Math.round(value * factor) / factor;
        }
        case 'IF': {
          if (args.length !== 3) throw new Error('IF needs exactly 3 arguments');
          return toBoolean(args[0], 'IF condition') ? args[1]! : args[2]!;
        }
        case 'MIN':
        case 'MAX': {
          if (args.length === 0) throw new Error(`${node.name} needs at least 1 argument`);
          const numbers = args.map((a) => toNumber(a, node.name));
          return node.name === 'MIN' ? Math.min(...numbers) : Math.max(...numbers);
        }
      }
      break;
    }
  }
  throw new Error('Cannot evaluate expression');
}

export function evaluateFormula(
  ast: FormulaExpr,
  resolve: RefResolver,
): { ok: true; value: FormulaValue } | { ok: false; error: string } {
  try {
    return { ok: true, value: evaluate(ast, resolve) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
