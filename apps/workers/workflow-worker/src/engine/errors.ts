/**
 * Engine error types.
 */

/**
 * Thrown by every not-yet-implemented engine skeleton. The TDD suite expects
 * these to disappear as the implementation lands.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

/** No integration of the requested type/id exists in the workspace. */
export class IntegrationNotFoundError extends Error {
  constructor(selector: string) {
    super(`Integration not found: ${selector}`);
    this.name = 'IntegrationNotFoundError';
  }
}

/** Integration exists but is not in a usable (connected) state. */
export class IntegrationNotConnectedError extends Error {
  constructor(selector: string, status: string) {
    super(`Integration ${selector} is not connected (status: ${status})`);
    this.name = 'IntegrationNotConnectedError';
  }
}
