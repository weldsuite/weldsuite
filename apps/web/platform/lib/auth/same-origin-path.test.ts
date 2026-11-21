import { describe, expect, it } from 'vitest';
import { sameOriginPath } from './same-origin-path';

describe('sameOriginPath', () => {
  it('keeps a path on this origin, with its query and fragment', () => {
    expect(sameOriginPath('/')).toBe('/');
    expect(sameOriginPath('/weldcrm/contacts')).toBe('/weldcrm/contacts');
    expect(sameOriginPath('/weldflow/projects?tab=board#task-1')).toBe('/weldflow/projects?tab=board#task-1');
  });

  it('falls back to / for anything that is not a path', () => {
    for (const value of [undefined, null, '', 'weldcrm', 'https://evil.example/x', 'javascript:alert(1)']) {
      expect(sameOriginPath(value), String(value)).toBe('/');
    }
  });

  it('never returns a path a browser reads as another host', () => {
    for (const value of [
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
    ]) {
      expect(sameOriginPath(value), JSON.stringify(value)).toBe('/');
    }
    // Parses on this origin, but its path would read as a host: collapsed.
    expect(sameOriginPath('/a/..//evil.example/x')).toBe('/evil.example/x');
  });
});
