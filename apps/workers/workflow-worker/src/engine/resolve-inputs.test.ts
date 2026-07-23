import { describe, it, expect } from 'vitest';
import { resolveInputs } from './resolve-inputs';

const NONE = {};

describe('resolveInputs', () => {
  it('returns non-template strings unchanged', () => {
    const out = resolveInputs({ greeting: 'plain text' }, NONE, NONE, NONE, NONE);
    expect(out.greeting).toBe('plain text');
  });

  it('passes through non-string scalars', () => {
    const out = resolveInputs({ n: 42, b: true, z: null }, NONE, NONE, NONE, NONE);
    expect(out).toEqual({ n: 42, b: true, z: null });
  });

  it('resolves {{steps.id.field}} from previous step output', () => {
    const out = resolveInputs(
      { msg: 'Hello {{steps.greet.name}}' },
      { greet: { name: 'Ada' } },
      NONE,
      NONE,
      NONE,
    );
    expect(out.msg).toBe('Hello Ada');
  });

  it('resolves a deep dotted path', () => {
    const out = resolveInputs(
      { city: '{{steps.lookup.address.city}}' },
      { lookup: { address: { city: 'Ghent' } } },
      NONE,
      NONE,
      NONE,
    );
    expect(out.city).toBe('Ghent');
  });

  it('resolves {{trigger.field}}', () => {
    const out = resolveInputs({ email: '{{trigger.email}}' }, NONE, { email: 'a@b.com' }, NONE, NONE);
    expect(out.email).toBe('a@b.com');
  });

  it('resolves {{variables.name}}', () => {
    const out = resolveInputs({ v: '{{variables.threshold}}' }, NONE, NONE, { threshold: 10 }, NONE);
    expect(out.v).toBe(10); // whole-expression preserves number type
  });

  it('resolves {{contact.field}}', () => {
    const out = resolveInputs({ c: '{{contact.firstName}}' }, NONE, NONE, NONE, { firstName: 'Lin' });
    expect(out.c).toBe('Lin');
  });

  it('preserves the original type when the whole value is one expression (array)', () => {
    const list = [1, 2, 3];
    const out = resolveInputs({ items: '{{steps.s.list}}' }, { s: { list } }, NONE, NONE, NONE);
    expect(out.items).toEqual(list);
    expect(Array.isArray(out.items)).toBe(true);
  });

  it('preserves the original type when the whole value is one expression (object)', () => {
    const obj = { a: 1 };
    const out = resolveInputs({ payload: '{{steps.s.obj}}' }, { s: { obj } }, NONE, NONE, NONE);
    expect(out.payload).toEqual(obj);
  });

  it('coerces to string when an expression is embedded in surrounding text', () => {
    const out = resolveInputs({ msg: 'n={{variables.count}}!' }, NONE, NONE, { count: 7 }, NONE);
    expect(out.msg).toBe('n=7!');
  });

  it('resolves multiple expressions in one string', () => {
    const out = resolveInputs(
      { line: '{{trigger.a}} + {{trigger.b}}' },
      NONE,
      { a: 'x', b: 'y' },
      NONE,
      NONE,
    );
    expect(out.line).toBe('x + y');
  });

  it('renders an unresolved embedded expression as empty string', () => {
    const out = resolveInputs({ msg: 'Hi {{trigger.missing}}.' }, NONE, {}, NONE, NONE);
    expect(out.msg).toBe('Hi .');
  });

  it('recurses into nested objects', () => {
    const out = resolveInputs(
      { headers: { 'X-User': '{{trigger.user}}' } },
      NONE,
      { user: 'u1' },
      NONE,
      NONE,
    );
    expect(out.headers).toEqual({ 'X-User': 'u1' });
  });

  it('recurses into arrays of objects', () => {
    const out = resolveInputs(
      { rows: [{ v: '{{trigger.x}}' }, { v: '{{trigger.y}}' }] },
      NONE,
      { x: '1', y: '2' },
      NONE,
      NONE,
    );
    expect(out.rows).toEqual([{ v: '1' }, { v: '2' }]);
  });
});
