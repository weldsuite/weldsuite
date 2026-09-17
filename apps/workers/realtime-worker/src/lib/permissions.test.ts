import { describe, expect, it } from 'vitest';
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

describe('getWorkspacePermissions', () => {
  it('owners and admins get wildcard (non-personal) subscribe', () => {
    expect(getWorkspacePermissions(auth('owner')).subscribe).toEqual(['*']);
    expect(getWorkspacePermissions(auth('admin')).subscribe).toEqual(['*']);
  });

  it('members can subscribe to project_task and email (not just project/task)', () => {
    const { subscribe } = getWorkspacePermissions(auth('member'));
    expect(canSubscribe(subscribe, 'project_task')).toBe(true);
    expect(canSubscribe(subscribe, 'email')).toBe(true);
    expect(canSubscribe(subscribe, 'mail_folder')).toBe(true);
    expect(canSubscribe(subscribe, 'mail_label')).toBe(true);
    expect(canSubscribe(subscribe, 'personal_task')).toBe(true);
    // Prefix semantics: project allows project.x but NOT project_task — listed explicitly above
    expect(canSubscribe(['project'], 'project_task')).toBe(false);
  });

  it('viewers can subscribe to task + mail topics for live-sync reads', () => {
    const { subscribe } = getWorkspacePermissions(auth('viewer'));
    expect(canSubscribe(subscribe, 'project_task')).toBe(true);
    expect(canSubscribe(subscribe, 'email')).toBe(true);
    expect(canSubscribe(subscribe, 'mail_folder')).toBe(true);
    expect(canSubscribe(subscribe, 'invoice')).toBe(false);
  });

  it('members only get their own personal mail topic', () => {
    const { subscribe } = getWorkspacePermissions(auth('member', 'user_abc'));
    expect(subscribe).toContain('mail.user_abc');
    expect(subscribe).not.toContain('mail');
    expect(isPersonalTopicForOtherUser('user_abc', 'mail.user_other')).toBe(true);
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
