/** What the OData feed throws; `index.ts` turns it into `{ error: { code, message } }`. */

export type ODataErrorStatus = 400 | 404 | 405 | 415 | 501;

const CODES: Record<ODataErrorStatus, string> = {
  400: 'BadRequest',
  404: 'NotFound',
  405: 'MethodNotAllowed',
  415: 'UnsupportedMediaType',
  501: 'NotImplemented',
};

export class ODataError extends Error {
  readonly status: ODataErrorStatus;
  readonly code: string;

  constructor(status: ODataErrorStatus, message: string) {
    super(message);
    this.name = 'ODataError';
    this.status = status;
    this.code = CODES[status];
  }
}

export const badRequest = (message: string): ODataError => new ODataError(400, message);
export const notImplemented = (message: string): ODataError => new ODataError(501, message);
