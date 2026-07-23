import { z } from 'zod';

export const memberProfileLink = z.object({
  label: z.string().min(1).max(40),
  url: z.string().url().max(500),
});

export type MemberProfileLink = z.infer<typeof memberProfileLink>;

// ============================================================================
// Update input (partial profile edit — self or admin)
// ============================================================================

export const updateMemberProfileInput = z
  .object({
    title: z.string().max(120).nullable(),
    bio: z.string().max(4000).nullable(),
    phone: z.string().max(40).nullable(),
    location: z.string().max(120).nullable(),
    pronouns: z.string().max(40).nullable(),
    links: z.array(memberProfileLink).max(10).nullable(),
    hoursPerWeek: z.number().min(0).max(168).nullable(),
    // workingHours: flexible JSON from helpdesk-agents' WorkingHours shape
    workingHours: z.record(z.string(), z.any()).nullable(),
    timezone: z.string().max(100),
  })
  .partial();

export type UpdateMemberProfileInput = z.infer<typeof updateMemberProfileInput>;

// ============================================================================
// Notes
// ============================================================================

export const memberNoteInput = z.object({
  body: z.string().max(20000),
});

export type MemberNoteInput = z.infer<typeof memberNoteInput>;

export interface MemberNote {
  id: string;
  authorUserId: string;
  subjectUserId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Profile response (shared profile view shown in the team member panel)
// ============================================================================

export interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
  breaks?: { start: string; end: string }[];
}

export interface WorkingHours {
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
}

export interface MemberProfile {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  role: string;
  status: string;

  // Profile
  title: string | null;
  bio: string | null;
  phone: string | null;
  location: string | null;
  pronouns: string | null;
  links: MemberProfileLink[] | null;

  // Work
  hoursPerWeek: string | null;
  workingHours: WorkingHours | null;
  timezone: string;

  // Edit capability for the viewer
  canEdit: boolean;
}

// ============================================================================
// Common concepts — things that link the viewer and the subject together
// ============================================================================

export type CommonConceptCategory =
  | 'channels'
  | 'projects'
  | 'tasks'
  | 'crm'
  | 'helpdesk';

export const commonConceptsQuery = z.object({
  categories: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? (v.split(',').filter(Boolean) as CommonConceptCategory[])
        : (['channels', 'projects', 'tasks', 'crm', 'helpdesk'] as CommonConceptCategory[]),
    ),
});

export type CommonConceptsQuery = z.infer<typeof commonConceptsQuery>;

export interface CommonChannel {
  id: string;
  name: string;
  type: 'public' | 'private' | 'dm';
  memberCount: number;
}

export interface CommonProject {
  id: string;
  name: string;
  status: string | null;
  color: string | null;
}

export interface CommonTask {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  dueDate: string | null;
  role: 'shared_assignee' | 'shared_watcher' | 'delegated';
}

export interface CommonCrmRecord {
  id: string;
  kind: 'opportunity' | 'activity';
  name: string;
  status: string | null;
}

export interface CommonHelpdeskItem {
  id: string;
  kind: 'conversation' | 'ticket';
  subject: string;
  status: string;
}

export interface CommonConceptsResponse {
  channels: CommonChannel[];
  projects: CommonProject[];
  tasks: CommonTask[];
  crm: CommonCrmRecord[];
  helpdesk: CommonHelpdeskItem[];
}

// ============================================================================
// Activity feed (admin-only)
// ============================================================================

export const listMemberActivityQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
});

export type ListMemberActivityQuery = z.infer<typeof listMemberActivityQuery>;

export interface MemberActivityItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  createdAt: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
}
