import { describe, expect, it } from 'vitest';
import {
  ENTITY_EVENTS,
  listMemberHubTopics,
  PERSONAL_HUB_TOPIC_PREFIXES,
} from '@weldsuite/entity-events';
import {
  canSubscribe,
  getWorkspacePermissions,
  isPersonalTopicForOtherUser,
} from './permissions';
import type { AuthInfo } from './protocol';

function auth(role: string, userId = 'user_abc'): AuthInfo {
  return {
    userId,
    userName: 'Test',
    workspaceId: 'org_1',
    role,
    type: 'agent',
  };
}

/** Hand-maintained member list from pre–Phase 0 (#275) for unlock delta. */
const PRE_PHASE0_MEMBER_TOPICS = [
  'project',
  'project_member',
  'project_document',
  'project_file',
  'project_goal',
  'project_message',
  'project_whiteboard',
  'project_milestone',
  'project_sprint',
  'project_task',
  'project_time_entry',
  'project_timesheet',
  'project_label',
  'task',
  'personal_task',
  'task_comment',
  'task_project',
  'task_tag',
  'time_entry',
  'contact',
  'company',
  'person',
  'lead',
  'opportunity',
  'product',
  'inventory',
  'invoice',
  'bill',
  'payment',
  'commerce_order',
  'ticket',
  'helpdesk',
  'email',
  'mail_account',
  'mail_attachment',
  'mail_domain',
  'mail_draft',
  'mail_folder',
  'mail_label',
  'presence',
] as const;

describe('getWorkspacePermissions', () => {
  it('owners and admins get wildcard (non-personal) subscribe', () => {
    expect(getWorkspacePermissions(auth('owner')).subscribe).toEqual(['*']);
    expect(getWorkspacePermissions(auth('admin')).subscribe).toEqual(['*']);
  });

  it('members can subscribe to every catalog hub topic (+ presence)', () => {
    const { subscribe } = getWorkspacePermissions(auth('member'));
    for (const topic of listMemberHubTopics()) {
      expect(canSubscribe(subscribe, topic)).toBe(true);
    }
    // Underscore types need explicit entries — short prefixes do not unlock them
    expect(canSubscribe(['project'], 'project_task')).toBe(false);
    expect(canSubscribe(subscribe, 'project_task')).toBe(true);
    expect(canSubscribe(subscribe, 'helpdesk_ticket')).toBe(true);
    expect(canSubscribe(subscribe, 'knowledge_page')).toBe(true);
    expect(canSubscribe(subscribe, 'meeting')).toBe(true);
    expect(canSubscribe(subscribe, 'domain')).toBe(true);
    expect(canSubscribe(subscribe, 'workflow')).toBe(true);
  });

  it('viewers share the same non-personal catalog set as members', () => {
    const member = getWorkspacePermissions(auth('member')).subscribe;
    const viewer = getWorkspacePermissions(auth('viewer')).subscribe;
    // Same entity + presence set; personal topics are user-scoped either way
    expect(viewer.filter((t) => !t.includes('user_abc')).sort()).toEqual(
      member.filter((t) => !t.includes('user_abc')).sort(),
    );
    expect(canSubscribe(viewer, 'invoice')).toBe(true);
    expect(canSubscribe(viewer, 'helpdesk_ticket')).toBe(true);
  });

  it('members only get their own personal mail topic (never bare personal prefixes)', () => {
    const { subscribe } = getWorkspacePermissions(auth('member', 'user_abc'));
    expect(subscribe).toContain('mail.user_abc');
    expect(subscribe).toContain('notification.user_abc');
    for (const prefix of PERSONAL_HUB_TOPIC_PREFIXES) {
      expect(subscribe).not.toContain(prefix);
    }
    expect(isPersonalTopicForOtherUser('user_abc', 'mail.user_other')).toBe(true);
  });

  it('allow-list stays locked to the entity-events catalog helper', () => {
    const { subscribe } = getWorkspacePermissions(auth('member'));
    const personal = new Set<string>(PERSONAL_HUB_TOPIC_PREFIXES);
    for (const entityType of Object.keys(ENTITY_EVENTS)) {
      if (personal.has(entityType)) {
        expect(canSubscribe(subscribe, entityType)).toBe(false);
      } else {
        expect(canSubscribe(subscribe, entityType)).toBe(true);
      }
    }
  });

  it('unlocks the pre–Phase 0 gap (catalog topics beyond the hand-maintained list)', () => {
    const hubTopics = listMemberHubTopics();
    const previouslyAllowed = new Set<string>(PRE_PHASE0_MEMBER_TOPICS);
    const newlyUnlocked = hubTopics.filter((t) => !previouslyAllowed.has(t));
    // Inventory baseline was ~84 sync-map keys blocked; hub list gap is larger
    // because the catalog includes unmapped modules (commerce/social/…).
    expect(newlyUnlocked.length).toBeGreaterThanOrEqual(84);
    expect(hubTopics.length).toBeGreaterThan(PRE_PHASE0_MEMBER_TOPICS.length);
  });
});

describe('canSubscribe', () => {
  it('matches exact topic or dotted child, not underscore suffix', () => {
    expect(canSubscribe(['project'], 'project')).toBe(true);
    expect(canSubscribe(['project'], 'project.proj_1')).toBe(true);
    expect(canSubscribe(['project'], 'project_task')).toBe(false);
    expect(canSubscribe(['*'], 'email')).toBe(true);
  });
});
