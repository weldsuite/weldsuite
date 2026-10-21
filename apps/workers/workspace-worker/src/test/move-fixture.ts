/**
 * Hand-written miniature of a tenant database, for the move-engine tests.
 * It covers the shapes the real tenant schema has: jsonb (including a jsonb
 * `null` in a NOT NULL column), numeric(20,6) with many digits, timestamptz
 * (including infinity), an enum, nulls, arrays, a composite primary key, a
 * primary key that is not `id`, a self-referencing foreign key, a foreign key
 * between two tables, a user trigger that double-counts when it fires on copied
 * rows, a trigger that is disabled on purpose, a vector column and
 * materialized views created WITH NO DATA.
 */

import type { PgliteTenant } from './pglite-tenant-sql';

export const FIXTURE_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TYPE ticket_status AS ENUM ('open', 'pending', 'closed');

CREATE TABLE accounts (
  id varchar(30) PRIMARY KEY,
  name text NOT NULL,
  balance numeric(20,6),
  ratio double precision,
  big bigint,
  status ticket_status NOT NULL DEFAULT 'open',
  settings jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE TABLE orders (
  id varchar(30) PRIMARY KEY,
  account_id varchar(30) NOT NULL,
  total numeric(20,6),
  placed_at timestamptz,
  meta jsonb,
  CONSTRAINT orders_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE order_lines (
  order_id varchar(30) NOT NULL,
  line_no integer NOT NULL,
  sku text,
  qty integer NOT NULL,
  PRIMARY KEY (order_id, line_no),
  CONSTRAINT order_lines_order_fk FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE folders (
  id varchar(30) PRIMARY KEY,
  parent_id varchar(30),
  name text NOT NULL,
  CONSTRAINT folders_parent_fk FOREIGN KEY (parent_id) REFERENCES folders(id)
);

CREATE TABLE correspondents (
  email text PRIMARY KEY,
  message_count integer NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id varchar(30) PRIMARY KEY,
  from_email text NOT NULL,
  direction text NOT NULL
);

CREATE FUNCTION track_inbound() RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'inbound' THEN
    INSERT INTO correspondents (email, message_count) VALUES (NEW.from_email, 1)
    ON CONFLICT (email) DO UPDATE SET message_count = correspondents.message_count + 1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION noop_trigger() RETURNS trigger AS $$
BEGIN
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER messages_track_inbound AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION track_inbound();
CREATE TRIGGER messages_audit_noop AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION noop_trigger();
ALTER TABLE messages DISABLE TRIGGER messages_audit_noop;

CREATE TABLE embeddings (
  id varchar(30) PRIMARY KEY,
  label text,
  embedding vector(3)
);

CREATE TABLE seeded_defaults (
  id varchar(30) PRIMARY KEY,
  label text
);

CREATE TABLE empty_table (
  id varchar(30) PRIMARY KEY,
  label text
);

CREATE MATERIALIZED VIEW account_totals AS
  SELECT account_id, sum(total) AS total FROM orders GROUP BY account_id WITH NO DATA;
CREATE MATERIALIZED VIEW account_names AS
  SELECT id, name FROM accounts WITH NO DATA;

CREATE TABLE __drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint,
  tag text
);
INSERT INTO __drizzle_migrations (hash, created_at, tag) VALUES
  ('hash-0', 1700000000000, '0000_init'),
  ('hash-1', 1700000100000, '0001_more');
`;

/** Tables of the fixture that hold data on the source, in no particular order. */
export const FIXTURE_DATA_TABLES = [
  'accounts',
  'orders',
  'order_lines',
  'folders',
  'correspondents',
  'messages',
  'embeddings',
  'seeded_defaults',
] as const;

export const FIXTURE_ACCOUNT_COUNT = 123; // 120 generated + 3 edge-case rows

/** Fill the source with data covering the edge cases. */
export async function seedSource(source: PgliteTenant): Promise<void> {
  await source.exec(`
    INSERT INTO accounts (id, name, balance, ratio, big, status, settings, payload, tags, created_at, note)
    SELECT
      'acc_' || lpad(i::text, 4, '0'),
      'Account ' || i,
      (i * 1234567.123457)::numeric(20,6),
      i / 3.0,
      i::bigint * 1000000007,
      (ARRAY['open','pending','closed'])[1 + i % 3]::ticket_status,
      jsonb_build_object('n', i, 'nested', jsonb_build_object('list', ARRAY[1,2,3])),
      '{}'::jsonb,
      ARRAY['t' || i, 'two words'],
      timestamptz '2026-01-01 00:00:00+00' + (i || ' hours')::interval + (i || ' microseconds')::interval,
      CASE WHEN i % 7 = 0 THEN NULL ELSE 'note ' || i END
    FROM generate_series(1, 120) i;

    INSERT INTO accounts (id, name, balance, ratio, big, status, settings, payload, tags, created_at, note) VALUES
      ('acc_edge1', E'Quote " backslash \\\\ newline \\n tab \\t unicode é 日本 😀',
       99999999999999.999999, 0.30000000000000004, 9223372036854775807, 'closed',
       '{"huge": 12345678901234567890123.45678901234567890, "trailing": 1.10, "s": "x"}'::jsonb,
       'null'::jsonb, ARRAY['a,b', 'c"d'], '2026-03-29 02:30:00.123456+02', ''),
      ('acc_edge2', 'all nulls', NULL, NULL, NULL, 'open', NULL, '[]'::jsonb, NULL,
       '1999-12-31 23:59:59.999999+00', NULL),
      ('acc_edge3', 'scalars', -0.000001, 1e308, -9223372036854775808, 'pending',
       '"just a string"'::jsonb, '42'::jsonb, ARRAY[]::text[], 'infinity', E'\\\\x');

    INSERT INTO orders (id, account_id, total, placed_at, meta)
    SELECT
      'ord_' || lpad(i::text, 4, '0'),
      'acc_' || lpad((1 + i % 120)::text, 4, '0'),
      (i * 99.995)::numeric(20,6),
      timestamptz '2026-02-01 12:00:00+00' + (i || ' minutes')::interval,
      CASE WHEN i % 5 = 0 THEN NULL ELSE jsonb_build_object('i', i, 'big', 12345678901234567890 + i) END
    FROM generate_series(1, 150) i;

    INSERT INTO order_lines (order_id, line_no, sku, qty)
    SELECT 'ord_' || lpad(i::text, 4, '0'), l, 'sku-' || i || '-' || l, 1 + (i + l) % 9
    FROM generate_series(1, 150) i, generate_series(1, 2) l;

    -- Parents sort AFTER some of their children: only a dropped self-FK lets the copy load them in key order.
    INSERT INTO folders (id, parent_id, name)
    SELECT 'fld_' || lpad(i::text, 3, '0'), CASE WHEN i = 60 THEN NULL ELSE 'fld_' || lpad((i + 1)::text, 3, '0') END, 'Folder ' || i
    FROM generate_series(60, 1, -1) i;

    INSERT INTO messages (id, from_email, direction)
    SELECT 'msg_' || lpad(i::text, 3, '0'), 'person' || (i % 5) || '@example.com',
           CASE WHEN i % 3 = 0 THEN 'outbound' ELSE 'inbound' END
    FROM generate_series(1, 40) i;

    INSERT INTO embeddings (id, label, embedding)
    SELECT 'emb_' || lpad(i::text, 3, '0'), 'label ' || i, ('[' || i || ',' || (i * 0.5) || ',-1.25]')::vector
    FROM generate_series(1, 30) i;

    INSERT INTO seeded_defaults (id, label) VALUES ('def_1', 'from source');

    REFRESH MATERIALIZED VIEW account_totals;
  `);
}

/** A warm-pool target: same schema, pre-seeded rows, one view already populated. */
export async function seedTarget(target: PgliteTenant): Promise<void> {
  await target.exec(`
    INSERT INTO seeded_defaults (id, label) VALUES ('def_1', 'pool seed'), ('def_2', 'pool seed too');
    INSERT INTO accounts (id, name, status, payload) VALUES ('acc_0001', 'stale pool row', 'open', '{}'::jsonb);
    REFRESH MATERIALIZED VIEW account_names;
  `);
}

export async function createFixturePair(
  create: () => Promise<PgliteTenant>,
): Promise<{ source: PgliteTenant; target: PgliteTenant }> {
  const source = await create();
  await source.exec(FIXTURE_SCHEMA_SQL);
  await seedSource(source);
  const target = await create();
  await target.exec(FIXTURE_SCHEMA_SQL);
  await seedTarget(target);
  return { source, target };
}
