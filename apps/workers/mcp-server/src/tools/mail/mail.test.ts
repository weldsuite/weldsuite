/**
 * The MCP server drafts mail; it never sends it.
 *
 * Sending, replying, forwarding, sending a draft and uploading files are
 * public-API only (external-api's `mail-sending`). These checks fail the build
 * if a tool, or a route mounted here, ever reaches one of them, so an AI agent
 * cannot send mail on someone's behalf.
 */

import { describe, it, expect } from 'vitest';
import { mailTools } from './index';
import { allTools } from '../registry';
import { canPerform, canUseScope } from '../../lib/permissions';

const SENDING = [/\/send$/, /\/reply$/, /\/forward$/];

function isSendingPath(method: string, path: string): boolean {
  if (SENDING.some((re) => re.test(path))) return true;
  // Uploads exist only to attach files to a send.
  return method === 'POST' && /^\/v1\/mail-attachments\/?$/.test(path);
}

describe('mail tools never send', () => {
  it('no tool calls a send, reply, forward, draft-send or upload route', () => {
    for (const tool of allTools) {
      expect(isSendingPath(tool.method, tool.path), `${tool.name} → ${tool.method} ${tool.path}`).toBe(false);
    }
  });

  it('no tool uses a send scope', () => {
    for (const tool of allTools) expect(tool.scope, tool.name).not.toMatch(/:send$/);
  });

  it('the mounted v1 router serves none of those routes', async () => {
    const { v1 } = await import('../../api/routes/v1');
    const sending = v1.routes.filter((r) => isSendingPath(r.method, `/v1${r.path}`));
    expect(sending.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('every mail tool points at a mail route', () => {
    for (const tool of mailTools) expect(tool.path, tool.name).toMatch(/^\/v1\/mail-/);
  });
});

describe('mail scopes map onto the WeldMail permissions', () => {
  it('mail_messages / mail_drafts / mail_attachments follow messages:*', () => {
    expect(canPerform(['messages:read'], 'mail_messages:read', 'GET')).toBe(true);
    expect(canPerform(['messages:read'], 'mail_messages:write', 'PATCH')).toBe(false);
    expect(canPerform(['messages:update'], 'mail_messages:write', 'PATCH')).toBe(true);
    expect(canPerform(['messages:create'], 'mail_drafts:write', 'POST')).toBe(true);
    expect(canPerform(['messages:create'], 'mail_drafts:write', 'DELETE')).toBe(false);
    expect(canPerform(['messages:read'], 'mail_attachments:read', 'GET')).toBe(true);
  });

  it('mail_accounts / mail_labels / mail_folders follow accounts:*', () => {
    expect(canUseScope(['accounts:read'], 'mail_accounts:read')).toBe(true);
    expect(canPerform(['accounts:create'], 'mail_labels:write', 'POST')).toBe(true);
    expect(canPerform(['accounts:read'], 'mail_labels:write', 'POST')).toBe(false);
    expect(canPerform(['accounts:read'], 'mail_folders:read', 'GET')).toBe(true);
  });
});
