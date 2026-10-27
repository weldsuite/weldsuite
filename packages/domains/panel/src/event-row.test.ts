import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PanelEventRow } from './event-row';

const schema = JSON.parse(readFileSync(path.join(__dirname, 'events-v1-schema.json'), 'utf8')) as {
  fields: { name: string; type: string; required: boolean }[];
};

/** Every key of PanelEventRow, so a column added to one side and not the other fails here. */
const ROW_KEYS: Record<keyof PanelEventRow, true> = {
  event_id: true, workspace_id: true, project_id: true, name: true, ts: true, received_at: true,
  distinct_id: true, anon_id: true, user_id: true, session_id: true, cookieless: true, url: true,
  host: true, path: true, title: true, referrer: true, referrer_host: true, utm_source: true,
  utm_medium: true, utm_campaign: true, utm_content: true, utm_term: true, country: true,
  region: true, city: true, device_type: true, browser: true, os: true, viewport_w: true,
  el_tag: true, el_selector: true, el_text: true, x: true, y: true, rel_x: true, rel_y: true,
  scroll_depth: true, error_message: true, properties: true, lib: true, lib_version: true,
};

describe('events_v1 stream schema', () => {
  it('has exactly the columns of PanelEventRow', () => {
    expect(schema.fields.map((f) => f.name).sort()).toEqual(Object.keys(ROW_KEYS).sort());
  });

  it('only uses types a Basin stream accepts', () => {
    const allowed = new Set(['string', 'int32', 'int64', 'float32', 'float64', 'bool', 'timestamp', 'json', 'binary']);
    for (const field of schema.fields) expect(allowed.has(field.type), field.name).toBe(true);
  });
});
