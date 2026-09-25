/**
 * Evaluates a plain arithmetic expression (numbers, + - * /, parentheses and
 * unary minus/plus) without handing it to `Function`/`eval`.
 *
 * Returns `null` when the expression is malformed.
 */
export function evaluateArithmetic(expression: string): number | null {
  const tokens = expression.match(/\d+(?:\.\d+)?|\.\d+|[+\-*/()]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s+/g, '')) return null;

  let pos = 0;

  const parseExpression = (): number | null => {
    let left = parseTerm();
    while (left !== null && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    while (left !== null && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++];
      const right = parseFactor();
      if (right === null) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };

  const parseFactor = (): number | null => {
    const token = tokens[pos++];
    if (token === undefined) return null;
    if (token === '-' || token === '+') {
      const value = parseFactor();
      if (value === null) return null;
      return token === '-' ? -value : value;
    }
    if (token === '(') {
      const value = parseExpression();
      if (tokens[pos++] !== ')') return null;
      return value;
    }
    const value = Number(token);
    return Number.isNaN(value) ? null : value;
  };

  const result = parseExpression();
  return pos === tokens.length ? result : null;
}
