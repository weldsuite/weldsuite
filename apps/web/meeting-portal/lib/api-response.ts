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
