/**
 * Workforce portal emails: the invite, and the sign-in code.
 *
 * White-label: the sender name and every visible string use the workspace's
 * portal name, never "WeldSuite", unless the workspace switched branding back
 * on. A missing SEND_EMAIL binding is a no-op so local runs and tests still
 * record the invite; the caller learns whether anything went out.
 */

import type { Context } from 'hono';
import { eq, or } from 'drizzle-orm';
import type { HrPortalAccess, HrPortalSettings } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { getMasterDb, masterSchema } from '../../db';
import { sendEmail } from '../../lib/cloudflare-email';

const SENDER_ADDRESS = 'noreply@weldsuite.org';

export function hrPortalOrigin(env: Env): string {
  if (env.HR_PORTAL_URL) return env.HR_PORTAL_URL.replace(/\/$/, '');
  if (env.ENVIRONMENT === 'production') return 'https://team.weldsuite.org';
  if (env.ENVIRONMENT === 'test') return 'https://team-test.weldsuite.org';
  return 'http://localhost:3022';
}

/** Portal root for a workspace: the custom domain when set, otherwise `<origin>/<slug>`. */
export function hrPortalUrl(env: Env, settings: Pick<HrPortalSettings, 'customDomain'>, workspaceSlug: string): string {
  if (settings.customDomain) return `https://${settings.customDomain}`;
  return `${hrPortalOrigin(env)}/${encodeURIComponent(workspaceSlug)}`;
}

/**
 * Workspace slug for a workspace key. Clerk-authenticated routes carry the
 * Clerk org id in `workspaceId` (see middleware/workspace-db.ts), not the
 * master workspace id, so match either.
 */
export async function workspaceSlugFor(env: Env, workspaceKey: string): Promise<string | null> {
  const w = masterSchema.workspaces;
  const [row] = await getMasterDb(env)
    .select({ slug: w.slug })
    .from(w)
    .where(or(eq(w.clerkOrgId, workspaceKey), eq(w.id, workspaceKey)))
    .limit(1);
  return row?.slug ?? null;
}

// ---------------------------------------------------------------------------
// Custom domains
//
// The custom hostname lives in the tenant DB, but the portal has to find the
// workspace from the hostname alone. A KV entry per hostname bridges that
// without a master-DB table: written when a workspace saves its domain,
// removed when it changes it. No TTL — it is the index, not a cache.
// ---------------------------------------------------------------------------

interface HostMapping {
  workspaceId: string;
  slug: string;
}

function hostKey(host: string): string {
  return `hrportal:host:${host.trim().toLowerCase()}`;
}

export async function resolvePortalHost(env: Env, host: string): Promise<HostMapping | null> {
  if (!env.WORKSPACE_CACHE?.get) return null;
  return (await env.WORKSPACE_CACHE.get(hostKey(host), 'json')) as HostMapping | null;
}

export class HostTakenError extends Error {
  constructor(host: string) {
    super(`${host} is already used by another workspace's portal`);
    this.name = 'HostTakenError';
  }
}

/**
 * Point `next` at this workspace and release `previous`. Throws when `next`
 * already belongs to a different workspace, so one hostname can never serve
 * two portals.
 */
export async function claimPortalHost(
  env: Env,
  workspaceId: string,
  previous: string | null,
  next: string | null,
): Promise<void> {
  if (!env.WORKSPACE_CACHE?.put) return;
  const prev = previous?.trim().toLowerCase() || null;
  const want = next?.trim().toLowerCase() || null;
  if (prev === want) return;

  if (want) {
    const existing = await resolvePortalHost(env, want);
    if (existing && existing.workspaceId !== workspaceId) throw new HostTakenError(want);
    const slug = await workspaceSlugFor(env, workspaceId);
    if (!slug) return;
    await env.WORKSPACE_CACHE.put(hostKey(want), JSON.stringify({ workspaceId, slug } satisfies HostMapping));
  }
  if (prev) {
    const existing = await resolvePortalHost(env, prev);
    if (!existing || existing.workspaceId === workspaceId) await env.WORKSPACE_CACHE.delete(hostKey(prev));
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function brandName(settings: HrPortalSettings): string {
  return settings.displayName?.trim() || (settings.hideWeldsuiteBranding ? 'Your team portal' : 'WeldHR');
}

function sender(settings: HrPortalSettings): string {
  // Strip characters that would break the RFC 5322 display name.
  const name = brandName(settings).replace(/["<>\r\n]/g, '').slice(0, 60);
  return `${name} <${SENDER_ADDRESS}>`;
}

function layout(settings: HrPortalSettings, body: string): string {
  const color = settings.primaryColor || '#111827';
  const logo = settings.logoUrl
    ? `<img src="${escapeHtml(settings.logoUrl)}" alt="${escapeHtml(brandName(settings))}" style="max-height:40px;margin-bottom:16px" />`
    : `<p style="font-weight:600;font-size:16px;margin:0 0 16px;color:${escapeHtml(color)}">${escapeHtml(brandName(settings))}</p>`;
  const footer = settings.hideWeldsuiteBranding
    ? ''
    : '<p style="color:#9ca3af;font-size:12px;margin-top:24px">Powered by WeldSuite</p>';
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827">${logo}${body}${footer}</div>`;
}

export async function sendHrPortalInviteEmail(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  params: { access: HrPortalAccess; settings: HrPortalSettings },
): Promise<boolean> {
  const { access, settings } = params;
  try {
    const slug = await workspaceSlugFor(c.env, c.get('workspaceId'));
    if (!slug) return false;
    const url = hrPortalUrl(c.env, settings, slug);
    const name = brandName(settings);
    const greeting = access.displayName ? `Hi ${access.displayName},` : 'Hi,';
    const purpose =
      access.kind === 'client'
        ? 'You now have access to the client portal, where you can follow your team, their results and milestones, and reach our account team.'
        : 'You now have access to your employee portal: your schedule, attendance, leave, coaching and evaluations in one place.';
    const subject = `You're invited to ${name}`;
    const text = [greeting, '', purpose, '', `Sign in with this email address at:`, url].join('\n');
    const html = layout(
      settings,
      `<p>${escapeHtml(greeting)}</p>
       <p>${escapeHtml(purpose)}</p>
       ${settings.welcomeMessage ? `<p>${escapeHtml(settings.welcomeMessage)}</p>` : ''}
       <p><a href="${escapeHtml(url)}" style="display:inline-block;background:${escapeHtml(settings.primaryColor || '#111827')};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open the portal</a></p>
       <p style="color:#6b7280;font-size:13px">Sign in with ${escapeHtml(access.email)}. We'll email you a one-time code.</p>`,
    );
    await sendEmail(c.env, { from: sender(settings), to: [access.email], subject, text, html });
    return true;
  } catch (err) {
    console.warn('[weldhr] portal invite email skipped:', err);
    return false;
  }
}

export async function sendHrPortalCodeEmail(
  env: Env,
  params: { to: string; otp: string; settings: HrPortalSettings },
): Promise<boolean> {
  const { settings } = params;
  const name = brandName(settings);
  const subject = `Your ${name} sign-in code: ${params.otp}`;
  const text = [
    `Your sign-in code is ${params.otp}.`,
    'It expires in 15 minutes.',
    '',
    'If you did not try to sign in, you can ignore this email.',
  ].join('\n');
  const html = layout(
    settings,
    `<p>Your sign-in code is:</p>
     <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0">${escapeHtml(params.otp)}</p>
     <p style="color:#6b7280;font-size:13px">It expires in 15 minutes. If you did not try to sign in, you can ignore this email.</p>`,
  );
  try {
    await sendEmail(env, { from: sender(settings), to: [params.to], subject, text, html });
    return true;
  } catch (err) {
    console.warn('[weldhr] portal sign-in email skipped:', err);
    return false;
  }
}
