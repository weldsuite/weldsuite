import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickProject, readLastProjectId, writeLastProjectId } from './last-project';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('last project', () => {
  it('is remembered per workspace', () => {
    writeLastProjectId('ws_1', 'wpp_a');
    writeLastProjectId('ws_2', 'wpp_b');
    expect(readLastProjectId('ws_1')).toBe('wpp_a');
    expect(readLastProjectId('ws_2')).toBe('wpp_b');
    expect(readLastProjectId('ws_3')).toBeNull();
  });

  it('does nothing without a workspace', () => {
    writeLastProjectId(null, 'wpp_a');
    expect(readLastProjectId(null)).toBeNull();
    expect(window.localStorage).toHaveLength(0);
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeLastProjectId('ws_1', 'wpp_a')).not.toThrow();
    expect(readLastProjectId('ws_1')).toBeNull();
  });
});

describe('pickProject', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('prefers the chosen project, then the remembered one, then the first', () => {
    expect(pickProject(projects, 'c', 'b')?.id).toBe('c');
    expect(pickProject(projects, null, 'b')?.id).toBe('b');
    expect(pickProject(projects, null, null)?.id).toBe('a');
  });

  it('skips ids that no longer exist', () => {
    expect(pickProject(projects, 'gone', 'also-gone')?.id).toBe('a');
    expect(pickProject([], 'a', 'a')).toBeUndefined();
  });
});
