import { describe, it, expect } from 'vitest';
import { listIntegrations, getIntegrationDef, getIntegrationByItemId } from './registry';
import { deriveActionTypes, deriveIntegrationTriggerTypes } from './catalog';

describe('integration registry', () => {
  it('exposes slack + google_sheets', () => {
    const ids = listIntegrations().map((d) => d.id);
    expect(ids).toContain('slack');
    expect(ids).toContain('google_sheets');
  });

  it('resolves a definition by id', () => {
    expect(getIntegrationDef('slack')?.label).toBe('Slack');
    expect(getIntegrationDef('nope')).toBeUndefined();
  });

  it('resolves the owning integration from a namespaced item id', () => {
    expect(getIntegrationByItemId('slack.post_message')?.id).toBe('slack');
    expect(getIntegrationByItemId('google_sheets.append_row')?.id).toBe('google_sheets');
    expect(getIntegrationByItemId('unknown.thing')).toBeUndefined();
  });
});

describe('catalog derivations', () => {
  it('derives namespaced action types in the builder shape', () => {
    const actions = deriveActionTypes();
    const post = actions.find((a) => a.id === 'slack.post_message');
    expect(post).toBeDefined();
    expect(post?.category).toBe('integration');
    expect(post?.provider).toBe('slack');
  });

  it('derives integration trigger types with provider + kind', () => {
    const triggers = deriveIntegrationTriggerTypes();
    const newRow = triggers.find((t) => t.id === 'google_sheets.new_row');
    expect(newRow).toMatchObject({ provider: 'google_sheets', kind: 'poll', category: 'integration' });
    const msg = triggers.find((t) => t.id === 'slack.message');
    expect(msg?.kind).toBe('webhook');
  });
});
