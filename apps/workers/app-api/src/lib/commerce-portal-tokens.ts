/**
 * KV helpers for the B2B commerce portal: magic-link / OTP challenges and
 * buyer sessions. Tokens are stored hashed (SHA-256 hex); only the buyer
 * ever sees the plaintext.
 */

import type { Env } from '../types';

export const OTP_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const RATE_LIMIT_TTL_SECONDS = 15 * 60;
export const RATE_LIMIT_MAX = 5;

export interface PortalChallenge {
  tokenHash: string;
  otpHash: string;
  email: string;
  workspaceId: string;
  accessIds: string[];
  attempts: number;
}

export interface PortalSession {
  workspaceId: string;
  personId: string;
  companyId: string;
  partyId: string;
  accessId: string;
  email: string;
}

export interface PortalPicker {
  workspaceId: string;
  email: string;
  accessIds: string[];
}

export function commercePortalOrigin(env: Env): string {
  if (env.COMMERCE_PORTAL_URL) return env.COMMERCE_PORTAL_URL.replace(/\/$/, '');
  if (env.ENVIRONMENT === 'production') return 'https://orders.weldsuite.org';
  if (env.ENVIRONMENT === 'test') return 'https://orders-test.weldsuite.org';
  return 'http://localhost:3021';
}

export function otpKvKey(workspaceId: string, email: string): string {
  return `cportal:otp:${workspaceId}:${email.trim().toLowerCase()}`;
}

export function sessionKvKey(tokenHash: string): string {
  return `cportal:sess:${tokenHash}`;
}

export function pickerKvKey(tokenHash: string): string {
  return `cportal:pick:${tokenHash}`;
}

export function rateLimitKvKey(workspaceId: string, email: string): string {
  return `cportal:rl:${workspaceId}:${email.trim().toLowerCase()}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomOtp(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

export async function kvGetJson<T>(env: Env, key: string): Promise<T | null> {
  if (!env.WORKSPACE_CACHE?.get) return null;
  const value = await env.WORKSPACE_CACHE.get(key, 'json');
  return (value as T | null) ?? null;
}

export async function kvPutJson(env: Env, key: string, value: unknown, ttl: number): Promise<void> {
  if (!env.WORKSPACE_CACHE?.put) return;
  await env.WORKSPACE_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

export async function kvDelete(env: Env, key: string): Promise<void> {
  if (!env.WORKSPACE_CACHE?.delete) return;
  await env.WORKSPACE_CACHE.delete(key);
}

export async function storeChallenge(
  env: Env,
  challenge: PortalChallenge,
  email: string,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  await kvPutJson(env, otpKvKey(challenge.workspaceId, normalized), challenge, OTP_TTL_SECONDS);
  await kvPutJson(env, `cportal:tok:${challenge.tokenHash}`, { email: normalized }, OTP_TTL_SECONDS);
  await kvPutJson(env, `cportal:otpidx:${challenge.otpHash}`, { email: normalized }, OTP_TTL_SECONDS);
}

export async function deleteChallenge(env: Env, challenge: PortalChallenge): Promise<void> {
  await kvDelete(env, otpKvKey(challenge.workspaceId, challenge.email));
  await kvDelete(env, `cportal:tok:${challenge.tokenHash}`);
  await kvDelete(env, `cportal:otpidx:${challenge.otpHash}`);
}

export async function consumeRateLimit(env: Env, workspaceId: string, email: string): Promise<boolean> {
  const key = rateLimitKvKey(workspaceId, email);
  const current = (await kvGetJson<{ count: number }>(env, key)) ?? { count: 0 };
  if (current.count >= RATE_LIMIT_MAX) return false;
  await kvPutJson(env, key, { count: current.count + 1 }, RATE_LIMIT_TTL_SECONDS);
  return true;
}
