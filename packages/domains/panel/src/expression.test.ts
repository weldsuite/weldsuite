import { describe, expect, it } from 'vitest';
import { evaluate, expressionIdentifiers, parseExpression, seriesIndex, toSql, type ExpressionNode } from './expression';

function ast(text: string, identifiers: 'series' | 'properties' = 'series', seriesCount?: number): ExpressionNode {
  const parsed = parseExpression(text, { identifiers, seriesCount });
  if (!parsed.ok) throw new Error(`${parsed.error.message} at ${parsed.error.position}`);
  return parsed.ast;
}

describe('parseExpression', () => {
  it('parses series formulas with precedence and parentheses', () => {
    expect(evaluate(ast('A / B * 100'), { A: 5, B: 20 })).toBe(25);
    expect(evaluate(ast('A + B * C'), { A: 1, B: 2, C: 3 })).toBe(7);
    expect(evaluate(ast('(A + B) * C'), { A: 1, B: 2, C: 3 })).toBe(9);
    expect(evaluate(ast('-A + 2'), { A: 5 })).toBe(-3);
    expect(evaluate(ast('a - -b'), { A: 5, B: 2 })).toBe(7);
    expect(evaluate(ast('A ÷ B × 100 − 1'), { A: 1, B: 4 })).toBe(24);
    expect(evaluate(ast('.5 * A + 1.25'), { A: 2 })).toBe(2.25);
  });

  it('returns the identifiers used, upper-cased for series', () => {
    const parsed = parseExpression('b / a + B', { identifiers: 'series' });
    expect(parsed.ok && parsed.identifiers).toEqual(['B', 'A']);
    expect(expressionIdentifiers(ast('price * quantity - price', 'properties'))).toEqual(['price', 'quantity']);
  });

  it('accepts property keys, $ keys included, in properties mode', () => {
    expect(evaluate(ast('$lcp / 1000', 'properties'), { $lcp: 2500 })).toBe(2.5);
    expect(evaluate(ast('price * qty', 'properties'), { price: 2, qty: 3 })).toBe(6);
  });

  it('refuses what is not a formula, with a position', () => {
    const bad: Array<[string, 'series' | 'properties', string]> = [
      ['', 'series', 'Enter a formula'],
      ['A +', 'series', 'ends too early'],
      ['A B', 'series', 'Expected an operator'],
      ['(A + B', 'series', 'Missing closing'],
      ['A + B)', 'series', 'Unmatched closing'],
      ['AB', 'series', 'letters A to E'],
      ['F', 'series', 'letters A to E'],
      ['A1', 'series', 'letters A to E'],
      ['C', 'series', 'no series C'],
      ['A; DROP TABLE x', 'series', 'Unexpected character'],
      ["A + 'x'", 'series', 'Unexpected character'],
      ['2A', 'series', 'operator between'],
      ['1.', 'series', 'digits after'],
      ['1e5', 'series', 'operator between'],
      ['9999999999999', 'series', 'too large'],
      ['a.b', 'properties', 'Unexpected character'],
      ['$$x', 'properties', 'not a property name'],
      ['A ** B', 'series', 'Expected a number'],
      [`${'x'.repeat(65)} + 1`, 'properties', 'not a property name'],
    ];
    for (const [text, identifiers, message] of bad) {
      const parsed = parseExpression(text, { identifiers, seriesCount: 2 });
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.message, text).toContain(message);
        expect(parsed.error.position).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('limits length, size and depth', () => {
    expect(parseExpression('A+'.repeat(300) + 'A', { identifiers: 'series' }).ok).toBe(false);
    expect(parseExpression('A' + '+A'.repeat(120), { identifiers: 'series' }).ok).toBe(false);
    expect(parseExpression('('.repeat(25) + 'A' + ')'.repeat(25), { identifiers: 'series' }).ok).toBe(false);
    expect(parseExpression('-'.repeat(25) + 'A', { identifiers: 'series' }).ok).toBe(false);
    expect(parseExpression('('.repeat(10) + 'A' + ')'.repeat(10), { identifiers: 'series' }).ok).toBe(true);
  });
});

describe('evaluate', () => {
  it('gives null for division by zero, missing values and non-finite results', () => {
    expect(evaluate(ast('A / B'), { A: 1, B: 0 })).toBeNull();
    expect(evaluate(ast('A / B'), { A: 1 })).toBeNull();
    expect(evaluate(ast('A + B'), { A: 1, B: null })).toBeNull();
    expect(evaluate(ast('A * B'), { A: Number.NaN, B: 1 })).toBeNull();
    expect(evaluate(ast('A * 1000000000000 * 1000000000000'), { A: 1e300 })).toBeNull();
    expect(evaluate(ast('0 / A'), { A: 4 })).toBe(0);
  });
});

describe('toSql', () => {
  const resolve = (name: string) => `json_get_float(e.properties, '${name}')`;

  it('writes identifiers through the resolver, numbers as decimals, division by zero as NULL', () => {
    expect(toSql(ast('price * qty / 2', 'properties'), resolve)).toBe(
      "(((json_get_float(e.properties, 'price')) * (json_get_float(e.properties, 'qty'))) / NULLIF(2.0, 0))",
    );
    expect(toSql(ast('-a + 0.25', 'properties'), resolve)).toBe("((-(json_get_float(e.properties, 'a'))) + 0.25)");
    expect(toSql(ast('--a', 'properties'), resolve)).toBe("(-(-(json_get_float(e.properties, 'a'))))");
    expect(toSql(ast('0.0000001 * a', 'properties'), resolve)).toBe("(0.0000001 * (json_get_float(e.properties, 'a')))");
  });

  it('never writes a comment marker or raw text', () => {
    const sql = toSql(ast('a - -1 - - -b', 'properties'), (n) => n);
    expect(sql).not.toContain('--');
  });

  it('lets the resolver refuse an identifier', () => {
    expect(() =>
      toSql(ast('a + secret', 'properties'), (n) => {
        if (n === 'secret') throw new Error('nope');
        return n;
      }),
    ).toThrow('nope');
  });
});

describe('seriesIndex', () => {
  it('maps letters to series', () => {
    expect(seriesIndex('A')).toBe(0);
    expect(seriesIndex('e')).toBe(4);
    expect(seriesIndex('F')).toBe(-1);
  });
});
