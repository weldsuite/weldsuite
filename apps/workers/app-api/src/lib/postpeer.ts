/**
 * PostPeer — unified social media posting API client.
 *
 * PostPeer (https://www.postpeer.dev) is WeldSuite's single upstream provider
 * for connecting social accounts, publishing/scheduling posts, and pulling
 * analytics across Instagram, X/Twitter, LinkedIn, Facebook, TikTok, etc.
 *
 * Auth model: ONE WeldSuite-level API key (`POSTPEER_API_KEY`, sent as the
 * `x-access-key` header). Each WeldSuite workspace maps to one PostPeer
 * "profile" that groups that workspace's connected channels. PostPeer holds
 * the platform OAuth tokens — WeldSuite never stores them.
 *
 * The client is a thin typed fetch wrapper. Business logic lives in
 * `services/social-publishing.ts`.
 */

const DEFAULT_BASE_URL = 'https://api.postpeer.dev/v1';

export type PostPeerPlatform =
  | 'facebook'
  | 'instagram'
  | 'twitter'
  | 'linkedin'
  | 'tiktok';

export interface PostPeerProfile {
  id: string;
  name: string;
  integrationCount?: number;
  createdAt?: string;
}

export interface PostPeerIntegration {
  id: string;
  platform: PostPeerPlatform | string;
  platformUserId?: string;
  name?: string;
  username?: string;
  avatarUrl?: string;
  profileId?: string;
  createdAt?: string;
}

export interface PostPeerMediaItem {
  type: 'image' | 'video' | 'gif';
  url: string;
}

export interface PostPeerCreatePostInput {
  content: string;
  platforms: Array<{ platform: string; accountId: string }>;
  mediaItems?: PostPeerMediaItem[];
  /** Publish immediately. Mutually exclusive with `scheduledAt`. */
  publishNow?: boolean;
  /** ISO timestamp to schedule at. Interpreted in `timezone` (defaults UTC). */
  scheduledAt?: string;
  timezone?: string;
  platformSpecificData?: Record<string, unknown>;
}

export interface PostPeerPlatformResult {
  platform: string;
  accountId?: string;
  success: boolean;
  platformPostUrl?: string;
  error?: string;
}

export interface PostPeerCreatePostResult {
  postId: string;
  status: 'published' | 'partial' | 'scheduled' | string;
  scheduledFor?: string;
  platforms: PostPeerPlatformResult[];
}

export interface PostPeerAnalytics {
  postId?: string;
  accountId?: string;
  platform?: string;
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  views?: number;
  engagement?: number;
  engagementRate?: number;
}

export class PostPeerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'PostPeerError';
  }
}

export interface PostPeerClientConfig {
  apiKey: string;
  baseUrl?: string;
}

export class PostPeerClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: PostPeerClientConfig) {
    if (!config.apiKey) {
      throw new Error('PostPeerClient requires an apiKey (POSTPEER_API_KEY)');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        'x-access-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const msg =
        (parsed as { message?: string; error?: string } | undefined)?.message ||
        (parsed as { error?: string } | undefined)?.error ||
        `PostPeer request failed (${res.status})`;
      throw new PostPeerError(msg, res.status, parsed);
    }

    return parsed as T;
  }

  /** Verify the API key is valid. */
  async healthCheck(): Promise<{ ok: boolean }> {
    return this.request('GET', '/health/auth');
  }

  /** Create a profile (a grouping of a workspace's connected channels). */
  async createProfile(name: string): Promise<PostPeerProfile> {
    return this.request('POST', '/profiles', { name });
  }

  /** List every profile in the PostPeer project. */
  async listProfiles(): Promise<PostPeerProfile[]> {
    const res = await this.request<
      PostPeerProfile[] | { data?: PostPeerProfile[]; profiles?: PostPeerProfile[] }
    >('GET', '/profiles');
    if (Array.isArray(res)) return res;
    return res.profiles ?? res.data ?? [];
  }

  /**
   * Build the hosted OAuth URL a user follows to connect a platform account.
   * The connected account lands under the given profile.
   */
  async getConnectUrl(
    platform: string,
    profileId: string,
    redirectUri?: string,
  ): Promise<{ url: string }> {
    return this.request('GET', `/connect/${platform}`, undefined, {
      profileId,
      redirectUri,
    });
  }

  /** List connected accounts (integrations) for a profile. */
  async listIntegrations(profileId: string): Promise<PostPeerIntegration[]> {
    const res = await this.request<
      PostPeerIntegration[] | { data?: PostPeerIntegration[]; integrations?: PostPeerIntegration[] }
    >('GET', '/connect/integrations', undefined, { profileId });
    if (Array.isArray(res)) return res;
    return res.data ?? res.integrations ?? [];
  }

  /** Create or schedule a post across one or more channels. */
  async createPost(
    input: PostPeerCreatePostInput,
  ): Promise<PostPeerCreatePostResult> {
    return this.request('POST', '/posts', input);
  }

  /**
   * Cancel/delete a scheduled or published post on PostPeer. Used when
   * rescheduling (cancel the old scheduled post before creating the new one)
   * and when cancelling, so an orphaned scheduled post can't still fire.
   */
  async deletePost(postpeerPostId: string): Promise<void> {
    await this.request('DELETE', `/posts/${encodeURIComponent(postpeerPostId)}`);
  }

  /** Fetch analytics for a post and/or account. */
  async getAnalytics(params: {
    postId?: string;
    accountId?: string;
    platform?: string;
  }): Promise<PostPeerAnalytics[]> {
    const res = await this.request<PostPeerAnalytics[] | { data?: PostPeerAnalytics[] }>(
      'GET',
      '/analytics',
      undefined,
      params,
    );
    if (Array.isArray(res)) return res;
    return res.data ?? [];
  }
}

/**
 * Verify a PostPeer webhook signature.
 *
 * PostPeer signs webhook deliveries with an HMAC-SHA256 of the raw body using
 * the configured webhook secret, sent in the `x-postpeer-signature` header
 * (hex). The endpoint is PUBLIC (no Clerk), so verification must fail closed:
 * when no secret is configured we REJECT (return false) rather than accept,
 * so a production misconfiguration can't leave the webhook open. Mirrors the
 * non-bypassable GitHub webhook verifier.
 */
export async function verifyPostPeerSignature(
  secret: string | undefined,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!secret) {
    console.error('[postpeer] POSTPEER_WEBHOOK_SECRET not set — rejecting webhook (fail closed)');
    return false;
  }
  if (!signatureHeader) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expected = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Normalise: allow a bare hex or a `sha256=` prefixed header.
  const provided = signatureHeader.replace(/^sha256=/i, '').trim().toLowerCase();

  if (provided.length !== expected.length) return false;
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/** Resolve a PostPeer client from worker env, or null when unconfigured. */
export function getPostPeerClient(env: {
  POSTPEER_API_KEY?: string;
  POSTPEER_BASE_URL?: string;
}): PostPeerClient | null {
  if (!env.POSTPEER_API_KEY) return null;
  return new PostPeerClient({
    apiKey: env.POSTPEER_API_KEY,
    baseUrl: env.POSTPEER_BASE_URL,
  });
}
