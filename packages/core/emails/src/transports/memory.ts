import type { EmailTransport, OutgoingEmail, SendResult } from '../transport';

export interface MemoryTransport extends EmailTransport {
  /** Every email handed to the transport, in order. */
  readonly sent: OutgoingEmail[];
}

/**
 * Where memory transports register themselves, so the conformance harness
 * (`@weldsuite/worker-kit/testing`) can see what a test's code sent, and give
 * the test the Rust backend's mail instead, without importing this package.
 */
export const MEMORY_TRANSPORTS = Symbol.for('weldsuite.emails.memoryTransports');

function registry(): Set<MemoryTransport> {
  const global = globalThis as { [MEMORY_TRANSPORTS]?: Set<MemoryTransport> };
  global[MEMORY_TRANSPORTS] ??= new Set();
  return global[MEMORY_TRANSPORTS];
}

/** Records instead of sending. For tests and local development. */
export function memoryTransport(): MemoryTransport {
  const sent: OutgoingEmail[] = [];
  const transport: MemoryTransport = {
    name: 'memory',
    sent,
    async send(email): Promise<SendResult> {
      sent.push(email);
      return { messageId: `<memory-${sent.length}@weldsuite.test>`, transport: 'memory' };
    },
  };
  registry().add(transport);
  return transport;
}
