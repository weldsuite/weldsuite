import { describe, expect, it } from 'vitest';
import worker from './index';

const env = { ENVIRONMENT: 'test' };

describe('desk-api', () => {
  it('answers unknown paths with the JSON error envelope', async () => {
    const res = await worker.fetch(new Request('http://local/nope'), env as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '/nope not found' } });
  });

  it('requires a bearer token on /api/*', async () => {
    const res = await worker.fetch(new Request('http://local/api/anything'), env as never);
    expect(res.status).toBe(401);
  });

  it('serves the public help-center feed and the helpdesk OAuth callbacks without Clerk', async () => {
    // No ?domain= → the help-center domain middleware answers, not the auth guard.
    const feed = await worker.fetch(new Request('http://local/public/helpcenter/config'), env as never);
    expect(feed.status).toBe(400);
    // Missing code/state → redirect back to the platform settings page.
    const callback = await worker.fetch(
      new Request('http://local/api/integrations/helpdesk/discord/callback'),
      env as never,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toContain('/settings/integrations/discord?error=missing_params');
  });
});
