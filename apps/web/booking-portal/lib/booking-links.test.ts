import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildManageUrl,
  resolveLinkSecret,
  resolvePortalOrigin,
  signBookingToken,
  verifyBookingToken,
} from './booking-links.ts';

describe('booking token', () => {
  it('verifies a token it signed', async () => {
    const token = await signBookingToken('s3cret', 'bkg_abc');
    assert.equal(await verifyBookingToken('s3cret', 'bkg_abc', token), true);
  });

  it('is deterministic and URL-safe', async () => {
    const a = await signBookingToken('s3cret', 'bkg_abc');
    const b = await signBookingToken('s3cret', 'bkg_abc');
    assert.equal(a, b);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });

  it('rejects a token for another booking, another secret, or garbage', async () => {
    const token = await signBookingToken('s3cret', 'bkg_abc');
    assert.equal(await verifyBookingToken('s3cret', 'bkg_other', token), false);
    assert.equal(await verifyBookingToken('other-secret', 'bkg_abc', token), false);
    assert.equal(await verifyBookingToken('s3cret', 'bkg_abc', 'not a token!'), false);
    assert.equal(await verifyBookingToken('s3cret', 'bkg_abc', ''), false);
    assert.equal(await verifyBookingToken('s3cret', 'bkg_abc', null), false);
    assert.equal(await verifyBookingToken('s3cret', 'bkg_abc', token.slice(0, -2)), false);
  });
});

describe('resolveLinkSecret', () => {
  it('prefers BOOKING_LINK_SECRET, then the tenant DB encryption keys', () => {
    assert.equal(resolveLinkSecret({ BOOKING_LINK_SECRET: 'a', DATABASE_ENCRYPTION_KEY: 'b' }), 'a');
    assert.equal(resolveLinkSecret({ DATABASE_ENCRYPTION_KEY: 'b' }), 'b');
    assert.equal(resolveLinkSecret({ DATABASE_ENCRYPTION_KEY_V2: 'c' }), 'c');
    assert.equal(resolveLinkSecret({ BOOKING_LINK_SECRET: '  ' }), null);
    assert.equal(resolveLinkSecret({}), null);
  });
});

describe('buildManageUrl', () => {
  it('builds a link into the portal booking page', () => {
    const url = buildManageUrl({
      origin: 'https://book.weldsuite.org/',
      workspaceSlug: 'acme',
      pageSlug: 'intro-call',
      bookingId: 'bkg_abc',
      token: 'tok-en_1',
      action: 'cancel',
    });
    assert.equal(
      url,
      'https://book.weldsuite.org/acme/intro-call?booking=bkg_abc&token=tok-en_1&action=cancel',
    );
  });
});

describe('resolvePortalOrigin', () => {
  it('uses the override when set', () => {
    assert.equal(resolvePortalOrigin({ override: 'https://book.example.com/' }), 'https://book.example.com');
  });

  it('prefers the forwarded host and proto', () => {
    assert.equal(
      resolvePortalOrigin({ forwardedHost: 'book.weldsuite.org', host: 'internal:3000', forwardedProto: 'https' }),
      'https://book.weldsuite.org',
    );
  });

  it('defaults to http for localhost and https otherwise', () => {
    assert.equal(resolvePortalOrigin({ host: 'localhost:3019' }), 'http://localhost:3019');
    assert.equal(resolvePortalOrigin({ host: 'book.weldsuite.org' }), 'https://book.weldsuite.org');
  });

  it('returns null without any host information', () => {
    assert.equal(resolvePortalOrigin({}), null);
  });
});
