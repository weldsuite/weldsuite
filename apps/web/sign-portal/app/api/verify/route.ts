import { NextRequest } from 'next/server';
import { forwardSessionRequest } from '@/lib/session-route';

/** Checks the emailed code or access code; on success sets the signer session cookie. */
export async function POST(req: NextRequest) {
  return forwardSessionRequest(req, '/verify');
}
