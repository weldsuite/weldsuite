/** The request shape every sample-data area handler receives. */

export const UNHANDLED = Symbol('weldpanel-sample-unhandled');

export interface SampleRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The full client path, e.g. `/panel/reports?projectId=…`. */
  path: string;
  /** Path segments after `/panel/`, decoded: `/panel/reports/rep_1/versions` → `['reports', 'rep_1', 'versions']`. */
  segments: string[];
  query: URLSearchParams;
  /** The JSON body of a POST, PUT or PATCH. */
  body: unknown;
  /** `getRaw`: the handler must return a `Response`. */
  raw: boolean;
}

/** Returns the response body, or `UNHANDLED` when the path isn't this area's. */
export type SampleAreaHandler = (request: SampleRequest) => unknown;
