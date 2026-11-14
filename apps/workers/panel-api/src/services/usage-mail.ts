/**
 * Sends a usage notice (`panel.usage`) to the workspace's owners, from
 * WeldSuite's address. The owners are read from the workspace's tenant
 * database (`workspace_members`); a workspace whose owners have no address
 * falls back to its admins. Mail never fails a settlement.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { resolveEmailLocale, sendSystemEmail, workspaceAppUrl, type EmailTransport } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { nextMonthStart } from './usage-settlement';
import type { UsageNotice } from './usage-notices';

const { workspaceMembers } = schema;

export interface Recipient {
  email: string;
  name: string | null;
}

type MemberReader = (workspaceId: string) => Promise<Recipient[]>;

async function membersWithRole(env: Env, workspaceId: string, roles: string[]): Promise<Recipient[]> {
  const db = await getTenantDbForWorkspace(env, workspaceId);
  const rows = await db
    .select({ email: workspaceMembers.email, name: workspaceMembers.name })
    .from(workspaceMembers)
    .where(and(inArray(workspaceMembers.role, roles), isNull(workspaceMembers.deletedAt)));
  return rows.filter((row): row is { email: string; name: string | null } => Boolean(row.email));
}

/** Owners with an address, else admins with one. */
export async function noticeRecipients(env: Env, workspaceId: string, read: MemberReader = (id) => membersWithRole(env, id, ['OWNER'])): Promise<Recipient[]> {
  const owners = await read(workspaceId);
  if (owners.length > 0) return owners;
  return membersWithRole(env, workspaceId, ['ADMIN']);
}

export interface UsageMailDeps {
  env: Env;
  /** Tests send through a memory transport and read members from a fake. */
  transport?: EmailTransport;
  recipients?: MemberReader;
}

/** Where the usage is shown in the platform. */
export function usageUrl(env: Pick<Env, 'PLATFORM_URL'>, clerkOrgId: string | null): string {
  return workspaceAppUrl((env.PLATFORM_URL || 'https://app.weldsuite.org').replace(/\/$/, ''), clerkOrgId, '/weldpanel/settings?tab=usage');
}

/** Returns how many owners were mailed. */
export async function sendUsageNotice(deps: UsageMailDeps, notice: UsageNotice): Promise<number> {
  const transport = deps.transport ?? workerTransport(deps.env);
  if (!transport) return 0;
  const to = await noticeRecipients(deps.env, notice.workspaceId, deps.recipients);
  let sent = 0;
  for (const recipient of to) {
    try {
      await sendSystemEmail(transport, {
        template: 'panel.usage',
        props: {
          workspaceName: notice.workspaceName,
          kind: notice.kind,
          events: notice.events,
          recordings: notice.recordings,
          resetsAt: nextMonthStart(notice.month),
          url: usageUrl(deps.env, notice.clerkOrgId),
        },
        to: recipient.email,
        locale: resolveEmailLocale(null),
        brand: { kind: 'weldsuite', module: 'WeldPanel' },
      });
      sent += 1;
    } catch (error) {
      console.error(`[panel-api] usage mail for workspace ${notice.workspaceId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sent;
}
