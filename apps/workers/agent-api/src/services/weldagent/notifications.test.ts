import { describe, expect, it } from 'vitest';
import {
  appCodesForCategory,
  weldagentChatActionUrl,
  weldagentRunActionUrl,
} from '@weldsuite/notifications';

describe('weldagent notification mapping', () => {
  it('targets the weldagent app plus the unified weldsuite app', () => {
    expect(appCodesForCategory('weldagent')).toEqual(['weldagent', 'weldsuite']);
  });

  it('builds chat and run action URLs the mobile deep-link parser expects', () => {
    expect(weldagentChatActionUrl('conv_1')).toBe('/weldagent/chat/conv_1');
    expect(weldagentRunActionUrl('agt_1', 'run_9')).toBe('/weldagent/agent/agt_1/run/run_9');
  });
});
