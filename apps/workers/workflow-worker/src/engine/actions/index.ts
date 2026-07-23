/**
 * Action handler registry + dispatcher.
 *
 * `executeAction(type, inputs, ctx)` looks the handler up by type and runs it.
 * Unknown types fall through to a passthrough result so an unrecognised step
 * never hard-fails a run.
 */

import type { ActionHandler, ActionContext } from '../types';
import { handleSendEmail, handleSendNotification, handleSlackMessage } from './communication';
import {
  handleCreateRecord,
  handleUpdateRecord,
  handleDeleteRecord,
  handleQueryData,
  handleTransform,
} from './data';
import { handleHttpRequest, handleWebhook } from './http';
import { handleSetVariable, handleLog, handleCondition, handleLoop, handleDelay } from './control';
import { handleAiGenerate, handleAiClassify } from './ai';
import { handleSendSms } from './sms';
import {
  handleAssignConversation,
  handleTagConversation,
  handleChangeConversationStatus,
  handleChangePriority,
  handleSendReply,
  handleAddInternalNote,
} from './helpdesk';
import {
  handleSendMessage,
  handleSendChoices,
  handleCollectInput,
  handleManualStep,
} from './interactive';
import { handleSlackPostMessage } from './providers/slack';
import { handleSheetsAppendRow, handleSheetsUpdateRow } from './providers/google-sheets';
import { handleGmailSendEmail } from './providers/gmail';
import { handleCalendarCreateEvent } from './providers/google-calendar';
import { handleTeamsPostMessage } from './providers/teams';
import { handleTwilioSendSms } from './providers/twilio';
import { handleNotionCreatePage, handleNotionUpdatePage } from './providers/notion';
import { handleAirtableCreateRecord, handleAirtableUpdateRecord } from './providers/airtable';
import { handleGithubCreateIssue, handleGithubCreateComment } from './providers/github';
import { handleAsanaCreateTask, handleAsanaUpdateTask } from './providers/asana';

export const actionHandlers: Record<string, ActionHandler> = {
  // Communication
  send_email: handleSendEmail,
  send_notification: handleSendNotification,
  send_sms: handleSendSms,
  slack_message: handleSlackMessage,
  // Data
  create_record: handleCreateRecord,
  update_record: handleUpdateRecord,
  delete_record: handleDeleteRecord,
  query_data: handleQueryData,
  transform: handleTransform,
  // Integration / HTTP
  http_request: handleHttpRequest,
  webhook: handleWebhook,
  // Third-party integrations (catalog: @weldsuite/workflow-integrations)
  'slack.post_message': handleSlackPostMessage,
  'google_sheets.append_row': handleSheetsAppendRow,
  'google_sheets.update_row': handleSheetsUpdateRow,
  'gmail.send_email': handleGmailSendEmail,
  'google_calendar.create_event': handleCalendarCreateEvent,
  'teams.post_message': handleTeamsPostMessage,
  'twilio.send_sms': handleTwilioSendSms,
  'notion.create_page': handleNotionCreatePage,
  'notion.update_page': handleNotionUpdatePage,
  'airtable.create_record': handleAirtableCreateRecord,
  'airtable.update_record': handleAirtableUpdateRecord,
  'github.create_issue': handleGithubCreateIssue,
  'github.create_comment': handleGithubCreateComment,
  'asana.create_task': handleAsanaCreateTask,
  'asana.update_task': handleAsanaUpdateTask,
  // Logic / utility
  set_variable: handleSetVariable,
  log: handleLog,
  condition: handleCondition,
  loop: handleLoop,
  delay: handleDelay,
  // AI
  ai_generate: handleAiGenerate,
  ai_classify: handleAiClassify,
  // Helpdesk
  assign_conversation: handleAssignConversation,
  tag_conversation: handleTagConversation,
  change_conversation_status: handleChangeConversationStatus,
  change_priority: handleChangePriority,
  send_reply: handleSendReply,
  add_internal_note: handleAddInternalNote,
  // Human-in-the-loop / chat widget interactive
  manual_step: handleManualStep,
  send_message: handleSendMessage,
  send_choices: handleSendChoices,
  collect_input: handleCollectInput,
};

/** Action types still to be implemented (none registered yet). */
export const DEFERRED_ACTION_TYPES = ['ai_auto_reply'] as const;

export async function executeAction(
  actionType: string,
  inputs: Record<string, unknown>,
  context: ActionContext,
): Promise<unknown> {
  const handler = actionHandlers[actionType];
  if (!handler) {
    // Unknown action → passthrough (never hard-fails a run).
    return { executed: true, type: actionType, inputs };
  }
  return handler(inputs, context);
}
