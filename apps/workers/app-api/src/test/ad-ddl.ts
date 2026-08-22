import { sql } from 'drizzle-orm';
import type { Database } from '../db';

const AD_DDL = [
  `CREATE TABLE IF NOT EXISTS ad_platform_connections (
    id varchar(30) PRIMARY KEY,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp,
    platform text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    meta_user_id varchar(255),
    meta_user_name varchar(255),
    oauth_tokens jsonb,
    token_expires_at timestamp,
    last_sync_at timestamp,
    last_error text
  )`,
  `CREATE TABLE IF NOT EXISTS ad_accounts (
    id varchar(30) PRIMARY KEY,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp,
    connection_id varchar(30) NOT NULL,
    platform_account_id varchar(255) NOT NULL,
    name varchar(255) NOT NULL,
    currency varchar(10),
    timezone varchar(100),
    status varchar(50),
    is_selected boolean NOT NULL DEFAULT false
  )`,
  `CREATE TABLE IF NOT EXISTS ad_campaigns (
    id varchar(30) PRIMARY KEY,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp,
    ad_account_id varchar(30) NOT NULL,
    platform_campaign_id varchar(255),
    name varchar(255) NOT NULL,
    status varchar(50),
    objective varchar(100),
    daily_budget integer,
    lifetime_budget integer,
    currency varchar(10),
    metrics jsonb,
    metrics_synced_at timestamp,
    content_hash varchar(64),
    sync_status text NOT NULL DEFAULT 'local',
    sync_error text,
    last_synced_at timestamp
  )`,
];

export async function ensureAdTables(db: Database): Promise<void> {
  for (const statement of AD_DDL) {
    await db.execute(sql.raw(statement));
  }
}

export const AD_TEST_CONNECTION_ID = 'adcn_test';

/** Seed a Facebook connection row required by ad_accounts FK constraints. */
export async function seedAdTestConnection(
  db: Database,
  connectionId = AD_TEST_CONNECTION_ID,
): Promise<void> {
  await db.execute(sql.raw(`
    INSERT INTO ad_platform_connections (id, platform, status, created_at, updated_at)
    VALUES ('${connectionId}', 'facebook', 'active', now(), now())
    ON CONFLICT (id) DO NOTHING
  `));
}
