/**
 * Sending domains: /v1/reach/domains
 *
 * Scope: reach_mailboxes:read. Read only: connecting and disconnecting a domain
 * (the mail provider, the DNS records, billing) stays in the WeldReach app. The
 * same domain reads as reach-api's `/api/reach/domains`; the mail provider's ids
 * are not part of the public API (`withoutMailpool`).
 */

import { Hono } from 'hono';
import { getDomainDto, listDomains } from '@weldsuite/reach-domain/domains';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, list, success } from '../../../lib/response';
import { withoutMailpool } from '../../../lib/reach';

const app = new Hono<HonoEnv>();

app.get('/', requireScope('reach_mailboxes:read'), async (c) => {
  const domains = (await listDomains(c.get('tenantDb'))).map(withoutMailpool);
  return list(c, domains, cursorPagination(domains.length, false, null));
});

app.get('/:id', requireScope('reach_mailboxes:read'), async (c) => {
  return success(c, withoutMailpool(await getDomainDto(c.get('tenantDb'), c.req.param('id'))));
});

export default app;
