import { describe, expect, it } from 'vitest';
import { ReachDomainError, reachError } from './errors';

describe('reachError', () => {
  it('builds the standard refusals with the codes and messages of the API envelope', () => {
    expect(reachError.badRequest('Unknown status filter', { a: 1 })).toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
      message: 'Unknown status filter',
      details: { a: 1 },
    });
    expect(reachError.forbidden()).toMatchObject({ code: 'FORBIDDEN', status: 403, message: 'Forbidden' });
    expect(reachError.notFound('Campaign', 'rcmp_1')).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: "Campaign with ID 'rcmp_1' not found",
    });
    expect(reachError.notFound('Thread')).toMatchObject({ message: 'Thread not found' });
    expect(reachError.conflict('Taken', { reason: 'X' })).toMatchObject({ code: 'CONFLICT', status: 409, details: { reason: 'X' } });
    expect(reachError.state('CAMPAIGN_ACTIVE', 'Pause it first')).toMatchObject({ code: 'CAMPAIGN_ACTIVE', status: 409 });
    expect(reachError.internal('Failed to create the campaign')).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(reachError.badGateway('The email could not be sent')).toMatchObject({ code: 'UPSTREAM_ERROR', status: 502 });
    expect(reachError.unavailable('Sending is paused. Try again later.')).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
  });

  it('is an Error carrying code, status and details', () => {
    const err = new ReachDomainError('MAILBOX_LIMIT_REACHED', 403, 'The mailbox limit is reached.', { limit: 5 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ReachDomainError);
    expect(err).toMatchObject({ name: 'ReachDomainError', code: 'MAILBOX_LIMIT_REACHED', status: 403, details: { limit: 5 } });
  });
});
