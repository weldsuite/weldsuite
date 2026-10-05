/**
 * Workforce portal emails: the invite, and the sign-in code.
 *
 * White-label: the sender name and every visible string use the workspace's
 * portal name, never "WeldSuite", unless the workspace switched branding back
 * on (`poweredBy: !settings.hideWeldsuiteBranding`). Sent through
 * @weldsuite/emails ('hr.portal-invite' / 'portal.sign-in'); a transport that
 * isn't configured (no SEND_EMAIL binding, no RESEND_API_KEY) is a no-op so
 * local runs and tests still record the invite — the caller learns whether
 * anything went out.
 *
 * SYSTEM_EMAIL_FROM pins the sender to the pre-existing
 * noreply@weldsuite.org address until mail.weldsuite.org is onboarded in
 * Cloudflare Email Service (docs/plans/system-email-cloudflare.md, Phase 0);
 * see the `[vars]` comment in wrangler.toml.
 */

import type { Context } from 'hono';
import { eq, or } from 'drizzle-orm';
import type { HrPortalAccess, HrPortalSettings } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { getMasterDb, masterSchema, schema } from '@weldsuite/worker-kit/db';
import { resolveEmailLocale, sendSystemEmail, type EmailBrand } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';

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

function brandName(settings: HrPortalSettings): string {
  return settings.displayName?.trim() || (settings.hideWeldsuiteBranding ? 'Your team portal' : 'WeldHR');
}

function brandOf(settings: HrPortalSettings): EmailBrand {
  return {
    kind: 'workspace',
    name: brandName(settings),
    logoUrl: settings.logoUrl,
    accentColor: settings.primaryColor,
    poweredBy: !settings.hideWeldsuiteBranding,
  };
}

/** The workspace's UI language, when it's one extra cheap tenant-DB row away. */
async function workspaceLanguage(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const [row] = await c
    .get('tenantDb')
    .select({ language: schema.workspaceSettings.language })
    .from(schema.workspaceSettings)
    .limit(1);
  return row?.language ?? undefined;
}

export async function sendHrPortalInviteEmail(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  params: { access: HrPortalAccess; settings: HrPortalSettings },
): Promise<boolean> {
  const { access, settings } = params;
  const transport = workerTransport(c.env);
  if (!transport) return false;
  try {
    const slug = await workspaceSlugFor(c.env, c.get('workspaceId'));
    if (!slug) return false;
    const url = hrPortalUrl(c.env, settings, slug);
    const language = await workspaceLanguage(c).catch(() => undefined);

    await sendSystemEmail(transport, {
      template: 'hr.portal-invite',
      props: {
        kind: access.kind === 'client' ? 'client' : 'employee',
        portalName: brandName(settings),
        recipientName: access.displayName,
        recipientEmail: access.email,
        welcomeMessage: settings.welcomeMessage,
        portalUrl: url,
      },
      to: access.email,
      locale: resolveEmailLocale(language),
      brand: brandOf(settings),
      fromName: brandName(settings),
    });
    return true;
  } catch (err) {
    console.warn('[weldhr] portal invite email skipped:', err);
    return false;
  }
}

export async function sendHrPortalCodeEmail(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  params: { to: string; otp: string; settings: HrPortalSettings },
): Promise<boolean> {
  const { settings } = params;
  const transport = workerTransport(c.env);
  if (!transport) return false;
  try {
    const language = await workspaceLanguage(c).catch(() => undefined);

    await sendSystemEmail(transport, {
      template: 'portal.sign-in',
      props: { portalName: brandName(settings), code: params.otp, expiresInMinutes: 15 },
      to: params.to,
      locale: resolveEmailLocale(language),
      brand: brandOf(settings),
      fromName: brandName(settings),
    });
    return true;
  } catch (err) {
    console.warn('[weldhr] portal sign-in email skipped:', err);
    return false;
  }
}
