/**
 * Signing links (ADR SIGN-002). A link is `${SIGN_PORTAL_URL}/r/<token>` with
 * 32 random bytes; only the token's SHA-256 is stored, in the master
 * `sign_link_registry`, which tells the public portal mount which workspace,
 * envelope and recipient the link belongs to. The tenant rows stay the source
 * of truth: a registry hit is always re-checked against them.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { sha256Hex } from './hash';

const { signLinkRegistry } = masterSchema;

/** How long a link keeps working after the request completes, to download the signed PDF. */
export const DOWNLOAD_WINDOW_DAYS = 30;

export function newLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function signingLink(portalUrl: string | undefined, token: string): string {
  return `${(portalUrl || 'https://sign.weldsuite.org').replace(/\/$/, '')}/r/${token}`;
}

export interface LinkTarget {
  /** Master `workspaces.id`. */
  workspaceId: string;
  clerkOrgId: string;
  envelopeId: string;
  recipientId: string;
  expiresAt: Date | null;
}

/** Create a link for one recipient; returns the token (shown once, in the email). */
export async function createLink(master: MasterDatabase, target: LinkTarget): Promise<string> {
  const token = newLinkToken();
  await master.insert(signLinkRegistry).values({
    id: generateId('sgl'),
    tokenHash: await sha256Hex(token),
    workspaceId: target.workspaceId,
    clerkOrgId: target.clerkOrgId,
    envelopeId: target.envelopeId,
    recipientId: target.recipientId,
    expiresAt: target.expiresAt,
  });
  return token;
}

export interface ResolvedLink {
  tokenHash: string;
  clerkOrgId: string;
  envelopeId: string;
  recipientId: string;
}

/** The live link for a token, or null (unknown, revoked or past its expiry). */
export async function resolveLink(master: MasterDatabase, token: string, now = new Date()): Promise<ResolvedLink | null> {
  const tokenHash = await sha256Hex(token);
  const [row] = await master
    .select()
    .from(signLinkRegistry)
    .where(and(eq(signLinkRegistry.tokenHash, tokenHash), isNull(signLinkRegistry.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < now.getTime()) return null;
  return { tokenHash, clerkOrgId: row.clerkOrgId, envelopeId: row.envelopeId, recipientId: row.recipientId };
}

/** Stop every link of an envelope at once (decline, void, expiry). */
export async function revokeEnvelopeLinks(master: MasterDatabase, workspaceId: string, envelopeId: string): Promise<void> {
  await master
    .update(signLinkRegistry)
    .set({ revokedAt: new Date() })
    .where(and(eq(signLinkRegistry.workspaceId, workspaceId), eq(signLinkRegistry.envelopeId, envelopeId), isNull(signLinkRegistry.revokedAt)));
}

/** After completion links only download the signed PDF, for a limited time. */
export async function limitLinksToDownload(master: MasterDatabase, workspaceId: string, envelopeId: string, completedAt: Date): Promise<void> {
  const until = new Date(completedAt.getTime() + DOWNLOAD_WINDOW_DAYS * 86_400_000);
  await master
    .update(signLinkRegistry)
    .set({ expiresAt: until })
    .where(and(eq(signLinkRegistry.workspaceId, workspaceId), eq(signLinkRegistry.envelopeId, envelopeId), isNull(signLinkRegistry.revokedAt)));
}
