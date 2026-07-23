/**
 * Environment configuration.
 *
 * Loads .env file and validates required variables at startup.
 */

import { config } from 'dotenv';
config({ path: process.env.ENV_FILE || '.env' });

export interface Env {
  PORT: number;
  ENVIRONMENT: string;

  // Discord
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  // Where to POST a JSON payload on every member online/offline transition.
  // Feature is disabled (handler no-ops) when this is unset.
  DISCORD_PRESENCE_WEBHOOK_URL?: string;

  // Database
  DATABASE_URL_MASTER: string;
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;

  // Realtime (for publishing events to platform UI)
  REALTIME_WORKER_URL?: string;
}

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;

  _env = {
    PORT: parseInt(process.env.PORT || '3060', 10),
    ENVIRONMENT: process.env.ENVIRONMENT || 'development',
    DISCORD_BOT_TOKEN: requiredEnv('DISCORD_BOT_TOKEN'),
    DISCORD_APPLICATION_ID: requiredEnv('DISCORD_APPLICATION_ID'),
    DISCORD_PRESENCE_WEBHOOK_URL: process.env.DISCORD_PRESENCE_WEBHOOK_URL,
    DATABASE_URL_MASTER: requiredEnv('DATABASE_URL_MASTER'),
    NEON_API_KEY: requiredEnv('NEON_API_KEY'),
    DATABASE_ENCRYPTION_KEY: process.env.DATABASE_ENCRYPTION_KEY,
    REALTIME_WORKER_URL: process.env.REALTIME_WORKER_URL,
  };

  return _env;
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}
