import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';

interface RateLimitState {
  count: number;
  windowStart: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

/**
 * Durable Object for distributed rate limiting
 * One instance per workspaceId ensures accurate per-tenant limits across all Workers
 */
export class RateLimiter extends DurableObject<Env> {
  private rateLimitState: RateLimitState | null = null;

  async checkLimit(config: RateLimitConfig): Promise<RateLimitResult> {
    const now = Date.now();

    if (!this.rateLimitState) {
      const stored = await this.ctx.storage.get<RateLimitState>('state');
      this.rateLimitState = stored ?? { count: 0, windowStart: now };
    }

    if (now - this.rateLimitState.windowStart >= config.windowMs) {
      this.rateLimitState = { count: 0, windowStart: now };
    }

    this.rateLimitState.count++;
    void this.ctx.storage.put('state', this.rateLimitState);

    const remaining = Math.max(0, config.maxRequests - this.rateLimitState.count);
    const allowed = this.rateLimitState.count <= config.maxRequests;
    const resetAt = this.rateLimitState.windowStart + config.windowMs;

    return { allowed, remaining, resetAt, limit: config.maxRequests };
  }

  async getStatus(config: RateLimitConfig): Promise<RateLimitResult> {
    const now = Date.now();

    if (!this.rateLimitState) {
      const stored = await this.ctx.storage.get<RateLimitState>('state');
      this.rateLimitState = stored ?? { count: 0, windowStart: now };
    }

    if (now - this.rateLimitState.windowStart >= config.windowMs) {
      return { allowed: true, remaining: config.maxRequests, resetAt: now + config.windowMs, limit: config.maxRequests };
    }

    const remaining = Math.max(0, config.maxRequests - this.rateLimitState.count);
    const allowed = this.rateLimitState.count < config.maxRequests;

    return { allowed, remaining, resetAt: this.rateLimitState.windowStart + config.windowMs, limit: config.maxRequests };
  }

  async reset(): Promise<void> {
    this.rateLimitState = null;
    await this.ctx.storage.delete('state');
  }
}
