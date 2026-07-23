import { describe, it, expect, beforeAll } from 'vitest';
import { resolveIntegration } from './integrations';
import { IntegrationNotFoundError, IntegrationNotConnectedError } from './errors';
import { createPgliteDb } from '../test/pglite';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

describe('resolveIntegration (pglite)', () => {
  let db: Database;
  let connectedId: string;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    connectedId = generateId('win');
    await db.insert(schema.workflowIntegrations).values([
      {
        id: connectedId,
        name: 'Connected',
        type: 'res_connected',
        status: 'connected',
        credentials: { apiKey: 'plain-key' },
        oauthTokens: { accessToken: 'at-1' },
        settings: { region: 'eu' },
      },
      {
        id: generateId('win'),
        name: 'Disconnected',
        type: 'res_disconnected',
        status: 'disconnected',
        credentials: { apiKey: 'x' },
      },
    ]);
  });

  it('resolves a connected integration by type with its credentials/oauth/settings', async () => {
    const integ = await resolveIntegration(db, { type: 'res_connected' });
    expect(integ.id).toBe(connectedId);
    expect(integ.status).toBe('connected');
    expect(integ.credentials).toEqual({ apiKey: 'plain-key' });
    expect(integ.oauthTokens?.accessToken).toBe('at-1');
    expect(integ.settings).toEqual({ region: 'eu' });
  });

  it('resolves a specific integration by id', async () => {
    const integ = await resolveIntegration(db, { integrationId: connectedId });
    expect(integ.id).toBe(connectedId);
    expect(integ.type).toBe('res_connected');
  });

  it('throws IntegrationNotFoundError when nothing matches', async () => {
    await expect(resolveIntegration(db, { type: 'res_missing' })).rejects.toBeInstanceOf(
      IntegrationNotFoundError,
    );
  });

  it('throws IntegrationNotConnectedError when the match is not connected', async () => {
    await expect(resolveIntegration(db, { type: 'res_disconnected' })).rejects.toBeInstanceOf(
      IntegrationNotConnectedError,
    );
  });

  it('applies the decrypt option to the credential bag', async () => {
    const integ = await resolveIntegration(
      db,
      { type: 'res_connected' },
      { decrypt: (c) => ({ ...c, apiKey: 'DECRYPTED' }) },
    );
    expect(integ.credentials.apiKey).toBe('DECRYPTED');
  });
});
