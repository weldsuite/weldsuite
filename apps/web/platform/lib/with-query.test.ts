import { describe, expect, it } from 'vitest';
import { withQuery } from './with-query';

describe('withQuery', () => {
  it('appends a non-empty query string', () => {
    expect(withQuery('/tasks', 'limit=10')).toBe('/tasks?limit=10');
  });

  it('leaves the path alone when the query is empty', () => {
    expect(withQuery('/tasks', '')).toBe('/tasks');
  });
});
