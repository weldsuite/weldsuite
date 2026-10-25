/**
 * Team-member profile data, from the same app-api endpoints the platform's
 * team-member panel reads (`/team-members/user/:userId/…`) plus chat presence
 * (`/chat-status`). Types mirror `@weldsuite/core-api-client/schemas/
 * member-profile`, which this app does not depend on.
 */
import { appApiClient } from '@/services/app-api';

export interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  breaks?: { start: string; end: string }[];
}

export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface MemberProfile {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  role: string;
  status: string;
  title: string | null;
  bio: string | null;
  phone: string | null;
  location: string | null;
  pronouns: string | null;
  links: { label: string; url: string }[] | null;
  hoursPerWeek: string | null;
  workingHours: Partial<Record<Weekday, DayHours>> | null;
  timezone: string;
  canEdit: boolean;
}

export interface MemberProfilePatch {
  title?: string | null;
  bio?: string | null;
  phone?: string | null;
  location?: string | null;
  pronouns?: string | null;
  hoursPerWeek?: number | null;
}

export interface CommonConcepts {
  channels: { id: string; name: string; type: 'public' | 'private' | 'dm'; memberCount: number }[];
  projects: { id: string; name: string; status: string | null; color: string | null }[];
  tasks: {
    id: string;
    title: string;
    status: string;
    projectId: string | null;
    role: 'shared_assignee' | 'shared_watcher' | 'delegated';
  }[];
  crm: { id: string; kind: 'opportunity' | 'activity'; name: string; status: string | null }[];
  helpdesk: { id: string; kind: 'conversation' | 'ticket'; subject: string; status: string }[];
}

export interface MemberActivityItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  createdAt: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
}

export interface MemberPresence {
  status: 'online' | 'busy' | 'away' | 'dnd' | 'offline';
  statusText?: string;
  statusEmoji?: string;
}

const base = (userId: string) => `/team-members/user/${encodeURIComponent(userId)}`;

export async function fetchMemberProfile(userId: string): Promise<MemberProfile> {
  const res = await appApiClient.get<{ data: MemberProfile }>(`${base(userId)}/profile`);
  return res.data;
}

export async function updateMemberProfile(userId: string, patch: MemberProfilePatch): Promise<MemberProfile> {
  const res = await appApiClient.patch<{ data: MemberProfile }>(`${base(userId)}/profile`, patch);
  return res.data;
}

export async function fetchCommonConcepts(userId: string): Promise<CommonConcepts> {
  const res = await appApiClient.get<{ data: CommonConcepts }>(`${base(userId)}/common`);
  return res.data;
}

export async function fetchMemberActivity(userId: string): Promise<MemberActivityItem[]> {
  const res = await appApiClient.get<{ data: MemberActivityItem[] }>(`${base(userId)}/activity?limit=50`);
  return res.data ?? [];
}

export async function fetchMemberNote(userId: string): Promise<string> {
  const res = await appApiClient.get<{ data: { body: string } | null }>(`${base(userId)}/notes`);
  return res.data?.body ?? '';
}

export async function saveMemberNote(userId: string, body: string): Promise<void> {
  await appApiClient.put(`${base(userId)}/notes`, { body });
}

export async function fetchMemberPresence(userId: string): Promise<MemberPresence> {
  const res = await appApiClient.get<{
    data?: { userId: string; status?: string; statusText?: string; statusEmoji?: string }[];
  }>('/chat-status');
  const row = (res.data ?? []).find((s) => s.userId === userId);
  const known = ['online', 'busy', 'away', 'dnd', 'offline'];
  return {
    status: (row?.status && known.includes(row.status) ? row.status : 'offline') as MemberPresence['status'],
    statusText: row?.statusText || undefined,
    statusEmoji: row?.statusEmoji || undefined,
  };
}

/** "Owner", "Admin", … — same mapping as the platform's role-label.ts. */
export function getRoleLabel(role: string): string {
  switch (role) {
    case 'OWNER': return 'Owner';
    case 'ADMIN': return 'Admin';
    case 'MEMBER': return 'Member';
    case 'VIEWER': return 'Viewer';
    default: return role.startsWith('role_') ? 'Custom role' : 'Member';
  }
}

export function formatLocalTime(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return '—';
  }
}

export function formatTimezoneOffset(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(now);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}
