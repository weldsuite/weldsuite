

// ---------------------------------------------------------------------------
// Token creation cache
// Reuse the same outbound token for ~24 h, refresh 10 min before expiry.
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

const TOKEN_TTL_SECONDS = 86_400; // 24 hours
const TOKEN_REFRESH_BUFFER_MS = 600_000; // 10 minutes

export async function createM2MToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const clerk = await clerkClient();
  const m2mToken = await clerk.m2m.createToken({
    machineSecretKey: process.env.CLERK_MACHINE_SECRET_KEY!,
    secondsUntilExpiration: TOKEN_TTL_SECONDS,
  });

  cachedToken = m2mToken.token!;
  cachedTokenExpiresAt = now + TOKEN_TTL_SECONDS * 1000 - TOKEN_REFRESH_BUFFER_MS;

  return cachedToken;
}

// ---------------------------------------------------------------------------
// Token verification cache
// Cache verified tokens for 5 minutes so repeated inbound calls skip the
// Clerk API.
// ---------------------------------------------------------------------------

const VERIFY_CACHE_TTL_MS = 300_000; // 5 minutes
const MAX_VERIFY_CACHE_SIZE = 100;

const verifiedTokens = new Map<string, number>(); // token -> expiresAt (ms)

async function verifyM2MRequest(request: Request): Promise<void> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing Authorization header');
  }

  const token = authHeader.slice(7);
  const now = Date.now();

  // Check cache
  const cachedExpiry = verifiedTokens.get(token);
  if (cachedExpiry && now < cachedExpiry) {
    return;
  }

  // Verify with Clerk
  const clerk = await clerkClient();
  await clerk.m2m.verifyToken({
    token,
    machineSecretKey: process.env.CLERK_MACHINE_SECRET_KEY!,
  });

  // Evict stale entries if cache is full
  if (verifiedTokens.size >= MAX_VERIFY_CACHE_SIZE) {
    for (const [key, exp] of verifiedTokens) {
      if (now >= exp) verifiedTokens.delete(key);
    }
  }

  // Cache the verified token
  verifiedTokens.set(token, now + VERIFY_CACHE_TTL_MS);
}
