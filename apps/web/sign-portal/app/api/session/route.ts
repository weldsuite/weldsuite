import { NextRequest } from 'next/server';
import { forwardSessionRequest } from '@/lib/session-route';

/** Opens a signing link: exchanges the link token for a signer session cookie. */
export async function POST(req: NextRequest) {
  return forwardSessionRequest(req, '/session');
}
