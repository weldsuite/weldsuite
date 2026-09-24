/** Error shapes shared by the fetch helpers and the query cache (kept separate to avoid an import cycle). */

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class PortalApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'PortalApiError';
    this.status = status;
    this.code = code;
  }
}
