import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PanelIdentityRow, PanelPersonRow, PanelReplayChunkRow } from './tables';

type Schema = { fields: { name: string; type: string; required: boolean }[] };

function schemaOf(file: string): Schema {
  return JSON.parse(readFileSync(path.join(__dirname, file), 'utf8')) as Schema;
}

/** Every key of each row type, so a column added to one side and not the other fails here. */
const IDENTITY_KEYS: Record<keyof PanelIdentityRow, true> = { workspace_id: true, project_id: true, anon_id: true, user_id: true, ts: true };
const PERSON_KEYS: Record<keyof PanelPersonRow, true> = {
  workspace_id: true, project_id: true, user_id: true, version: true, ts: true, properties: true, deleted: true,
};
const CHUNK_KEYS: Record<keyof PanelReplayChunkRow, true> = {
  workspace_id: true, project_id: true, session_id: true, seq: true, ts_start: true, ts_end: true,
  bytes: true, has_full_snapshot: true, r2_key: true,
};

const TABLES = [
  ['identities_v1', 'identities-v1-schema.json', IDENTITY_KEYS],
  ['people_v1', 'people-v1-schema.json', PERSON_KEYS],
  ['replay_chunks_v1', 'replay-chunks-v1-schema.json', CHUNK_KEYS],
] as const;

describe.each(TABLES)('%s stream schema', (_table, file, keys) => {
  const schema = schemaOf(file);

  it('has exactly the columns of its row type', () => {
    expect(schema.fields.map((f) => f.name).sort()).toEqual(Object.keys(keys).sort());
  });

  it('only uses types a Basin stream accepts', () => {
    const allowed = new Set(['string', 'int32', 'int64', 'float32', 'float64', 'bool', 'timestamp', 'json', 'binary']);
    for (const field of schema.fields) expect(allowed.has(field.type), field.name).toBe(true);
  });

  it('requires the ids every row needs', () => {
    for (const name of ['workspace_id', 'project_id']) {
      expect(schema.fields.find((f) => f.name === name)?.required, name).toBe(true);
    }
  });
});
