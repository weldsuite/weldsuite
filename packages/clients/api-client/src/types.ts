/**
 * Shared API client interface — framework-agnostic.
 */

import type { StepUpHandler } from './step-up.js';

export interface ClientApiOptions {
  getToken: () => Promise<string | null>;
  /**
   * API origin. Either one origin for every request, or a function that picks
   * the origin per request from the full path (`/api/tickets/123`), which is
   * how clients route modules that moved to their own worker
   * (`createApiOriginResolver` in @weldsuite/api-modules).
   */
  baseUrl: string | ((path: string) => string);
  apiPrefix?: string;
  /**
   * Extra headers merged into every request after auth. Used by WeldBooks to
   * send `X-Accounting-Entity-Id` when the user has switched administration.
   */
  getExtraHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Asks the user to confirm their identity when the API refuses a sensitive
   * action with `MFA_REQUIRED` / `REVERIFICATION_REQUIRED` (`step-up.ts`).
   * Resolving `true` sends the request once more, with a fresh token from
   * `getToken`; without it, or on `false`, the refusal is thrown as usual.
   */
  onStepUp?: StepUpHandler;
}

export interface ClientApi {
  get<T>(path: string): Promise<T>;
  getRaw(path: string): Promise<Response>;
  post<T>(path: string, data?: unknown): Promise<T>;
  put<T>(path: string, data?: unknown): Promise<T>;
  patch<T>(path: string, data?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  postForm<T>(path: string, form: FormData): Promise<T>;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: PaginationMeta;
}

export interface SingleResponse<T> {
  success: boolean;
  data: T;
}
