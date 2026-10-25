import { describe, expect, it } from 'vitest';
import { recipientLabel } from './recipients';

describe('recipientLabel', () => {
  const client = { roleName: 'Client', name: 'Ann', email: 'ann@example.com' };

  it("names a template's recipient by its role", () => {
    expect(recipientLabel(client, 'template')).toBe('Client');
    expect(recipientLabel({ roleName: 'Client', name: null, email: null }, 'template')).toBe('Client');
  });

  it("names a request's recipient by the person, even when the request came from a template", () => {
    expect(recipientLabel(client, 'envelope')).toBe('Ann');
    expect(recipientLabel({ roleName: 'Client', name: null, email: 'ann@example.com' }, 'envelope')).toBe('ann@example.com');
  });

  it('falls back to the person when a template recipient has no role name, and to nothing at all', () => {
    expect(recipientLabel({ roleName: null, name: 'Ann', email: null }, 'template')).toBe('Ann');
    expect(recipientLabel({ roleName: null, name: null, email: null }, 'envelope')).toBe('');
  });
});
