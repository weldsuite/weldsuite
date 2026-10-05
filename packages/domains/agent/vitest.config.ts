import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], pool: 'forks' },
  resolve: {
    alias: {
      // Workers-only module; complete-turn.ts / run.ts import
      // @weldsuite/notifications (sendWeldAgentReplyNotification /
      // sendWeldAgentRunNotification), which now transitively imports
      // @weldsuite/emails/transports/binding → cloudflare:email.
      'cloudflare:email': path.resolve(
        __dirname,
        '../../core/worker-email/src/testing/cloudflare-email-stub.ts',
      ),
    },
  },
});
