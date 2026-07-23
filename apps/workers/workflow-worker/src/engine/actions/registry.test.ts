import { describe, it, expect } from 'vitest';
import { executeAction, actionHandlers, DEFERRED_ACTION_TYPES } from './index';
import { makeActionContext } from '../../test/ctx';

describe('action registry', () => {
  it('registers all implemented actions', () => {
    for (const type of [
      // communication
      'send_email',
      'send_notification',
      'send_sms',
      'slack_message',
      // data
      'create_record',
      'update_record',
      'delete_record',
      'query_data',
      'transform',
      // http
      'http_request',
      'webhook',
      // control
      'set_variable',
      'log',
      'condition',
      'loop',
      'delay',
      // ai
      'ai_generate',
      'ai_classify',
      // helpdesk
      'assign_conversation',
      'tag_conversation',
      'change_conversation_status',
      'change_priority',
      'send_reply',
      'add_internal_note',
      // interactive
      'manual_step',
      'send_message',
      'send_choices',
      'collect_input',
    ]) {
      expect(actionHandlers[type], `expected handler for ${type}`).toBeTypeOf('function');
    }
  });

  it('does not yet register deferred actions', () => {
    for (const type of DEFERRED_ACTION_TYPES) {
      expect(actionHandlers[type]).toBeUndefined();
    }
  });

  it('returns a passthrough result for an unknown action type', async () => {
    const res = (await executeAction('totally_unknown', { a: 1 }, makeActionContext())) as Record<
      string,
      unknown
    >;
    expect(res).toEqual({ executed: true, type: 'totally_unknown', inputs: { a: 1 } });
  });

  it('dispatches to the registered handler for a known type', async () => {
    // A known type routes to its handler (the log handler), NOT the unknown
    // passthrough branch.
    const res = (await executeAction('log', { message: 'hi' }, makeActionContext())) as Record<
      string,
      unknown
    >;
    expect(res).toMatchObject({ logged: true, message: 'hi' });
    expect(res).not.toHaveProperty('executed');
  });
});
