import type { EmailTransport, OutgoingEmail, SendResult } from '../transport';

export interface MemoryTransport extends EmailTransport {
  /** Every email handed to the transport, in order. */
  readonly sent: OutgoingEmail[];
}

/** Records instead of sending. For tests and local development. */
export function memoryTransport(): MemoryTransport {
  const sent: OutgoingEmail[] = [];
  return {
    name: 'memory',
    sent,
    async send(email): Promise<SendResult> {
      sent.push(email);
      return { messageId: `<memory-${sent.length}@weldsuite.test>`, transport: 'memory' };
    },
  };
}
