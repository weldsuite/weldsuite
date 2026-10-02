/**
 * Small response helpers for the meeting-portal's own API routes.
 * Mirrors the booking-portal's error shape: { error: { code, message, details? } }.
 */

import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';

export function invalidInput(error: ZodError, message = 'Invalid request') {
  return NextResponse.json(
    { error: { code: 'invalid_input', message, details: error.flatten() } },
    { status: 400 },
  );
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
