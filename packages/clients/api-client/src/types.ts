/**
 * Shared API client interface — framework-agnostic.
 */

export interface ClientApiOptions {
  getToken: () => Promise<string | null>;
  baseUrl: string;
  apiPrefix?: string;
  /**
   * Extra headers merged into every request after auth. Used by WeldBooks to
   * send `X-Accounting-Entity-Id` when the user has switched administration.
   */
  getExtraHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
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
