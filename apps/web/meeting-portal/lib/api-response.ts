/**
 * Small response helpers for the meeting-portal's own API routes.
 * Mirrors the booking-portal's error shape: { error: { code, message, details? } }.
 */

import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';
import { isTenantNotFoundError } from './db';

export function invalidInput(error: ZodError, message = 'Invalid request') {
  return NextResponse.json(
    { error: { code: 'invalid_input', message, details: error.flatten() } },
    { status: 400 },
  );
}

/** The meeting (or the workspace it would live in) does not exist. */
export function meetingNotFound() {
  return NextResponse.json(
    { error: { code: 'NOT_FOUND', message: 'Meeting not found' } },
    { status: 404 },
  );
}

/**
 * 404 when `err` is the tenant lookup failing because the workspace id from
 * the URL does not exist, otherwise null so the caller falls through to its
 * own 500. An unknown workspace is indistinguishable from an unknown meeting.
 */
export function tenantNotFoundResponse(err: unknown): NextResponse | null {
  return isTenantNotFoundError(err) ? meetingNotFound() : null;
}

/** Missing, invalid or expired guest session token. */
export function guestUnauthorized() {
  return NextResponse.json(
    { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid guest session' } },
    { status: 401 },
  );
}

/** Valid token, but the guest is no longer an active participant. */
export function notActiveParticipant() {
  return NextResponse.json(
    { error: { code: 'FORBIDDEN', message: 'Not an active meeting participant' } },
    { status: 403 },
  );
}
