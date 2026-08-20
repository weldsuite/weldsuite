export class RealtimeRegistrarError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly endpoint?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RealtimeRegistrarError';
  }
}
