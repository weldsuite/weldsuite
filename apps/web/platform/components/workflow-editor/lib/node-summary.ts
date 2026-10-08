/**
 * One-line summaries for the nodes of the workflow canvas: what a trigger fires
 * on ("Task created", "Every day at 9:00") and what an action will do ("To:
 * jane@example.com", "Configured"). They replace the canvas' generic
 * "Click to configure" / "Not configured" once a node has been set up.
 *
 * Pure functions with the translated strings passed in, so they stay testable
 * without the i18n provider. The canvas package itself is i18n-free and just
 * shows the `summary` it is handed.
 */

import { isStepConfigured } from '@weldsuite/ui/components/workflow-canvas';

type Bag = Record<string, unknown>;

export interface NodeSummaryLabels {
  /** Generic summary of an action whose required fields are all filled in. */
  configured: string;
  /** `To: {to}` */
  to: string;
  /** `Wait {duration} {unit}` */
  delay: string;
  /** `Entity: {entityType}` */
  entity: string;
  trigger: {
    manual: string;
    webhook: string;
    api: string;
    /** Integration event without a known provider/event. */
    integrationEvent: string;
    /** Recurring schedule whose cron matches no preset and is blank. */
    recurringSchedule: string;
    /** Schedule with a type or time but nothing more specific to show. */
    scheduled: string;
    /** `After {name} succeeds` */
    afterSucceeds: string;
    /** `After {name} fails` */
    afterFails: string;
    /** `After {name} finishes` */
    afterFinishes: string;
  };
}

export interface TriggerSummaryContext {
  labels: NodeSummaryLabels;
  /** The entity-event catalog the trigger panel offers (labels and event names). */
  entityEvents: ReadonlyArray<{
    entityType: string;
    label?: string;
    events: ReadonlyArray<string | { id: string; name: string }>;
  }>;
  /** Cron presets, to show "Every day at 9:00" instead of `0 9 * * *`. */
  cronPresets: ReadonlyArray<{ cron: string; label: string }>;
  /** Workflows a `workflow_complete` trigger can wait for. */
  workflows: ReadonlyArray<{ id: string; name: string }>;
  /** Connected-app events, for `integration_event` triggers. */
  integrationTriggers: ReadonlyArray<{ id: string; name: string }>;
  /** BCP 47 locale for dates. */
  locale: string;
}

function asBag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Trigger fields are stored flat by the editor; older rows nest them under `config`. */
function triggerField(trigger: Bag, key: string): string {
  return text(trigger[key]) || text(asBag(trigger.config)[key]);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim();
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function summarizeEntityEvent(trigger: Bag, ctx: TriggerSummaryContext): string | undefined {
  const entityType = triggerField(trigger, 'entityType');
  const eventType = triggerField(trigger, 'eventType');
  if (!entityType || !eventType) return undefined;

  const entity = ctx.entityEvents.find((candidate) => candidate.entityType === entityType);
  const event = entity?.events.find((candidate) => (typeof candidate === 'string' ? candidate : candidate.id) === eventType);
  if (event && typeof event !== 'string' && event.name) return sentenceCase(event.name);
  return sentenceCase(`${entity?.label ?? humanize(entityType)} ${humanize(eventType)}`);
}

function formatExecuteAt(executeAt: string, locale: string): string {
  const date = new Date(executeAt);
  if (Number.isNaN(date.getTime())) return executeAt;
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function summarizeSchedule(trigger: Bag, ctx: TriggerSummaryContext): string | undefined {
  const scheduleType = triggerField(trigger, 'scheduleType');
  const cronExpression = triggerField(trigger, 'cronExpression');
  const executeAt = triggerField(trigger, 'executeAt');

  if (scheduleType === 'one_time' || (!scheduleType && !cronExpression && executeAt)) {
    return executeAt ? formatExecuteAt(executeAt, ctx.locale) : undefined;
  }
  if (cronExpression) {
    return ctx.cronPresets.find((preset) => preset.cron === cronExpression)?.label ?? cronExpression;
  }
  if (scheduleType === 'recurring') return ctx.labels.trigger.recurringSchedule;
  return undefined;
}

function summarizeWorkflowComplete(trigger: Bag, ctx: TriggerSummaryContext): string | undefined {
  const sourceId = triggerField(trigger, 'sourceWorkflowId');
  const name = ctx.workflows.find((workflow) => workflow.id === sourceId)?.name;
  if (!name) return undefined;
  const triggerOn = triggerField(trigger, 'triggerOn');
  const { afterSucceeds, afterFails, afterFinishes } = ctx.labels.trigger;
  let template = afterSucceeds;
  if (triggerOn === 'failure') template = afterFails;
  else if (triggerOn === 'both') template = afterFinishes;
  return template.replace('{name}', name);
}

function summarizeIntegrationEvent(trigger: Bag, ctx: TriggerSummaryContext): string {
  const event = triggerField(trigger, 'event');
  const provider = triggerField(trigger, 'provider');
  if (!event) return ctx.labels.trigger.integrationEvent;
  const known = ctx.integrationTriggers.find((candidate) => candidate.id === event);
  if (known) return known.name;
  return provider ? `${provider}: ${event}` : event;
}

/**
 * What the trigger node should say under its title, or `undefined` when the
 * trigger is not configured far enough to summarise (the canvas then keeps its
 * own "Click to configure").
 */
export function summarizeTrigger(trigger: Bag | undefined, ctx: TriggerSummaryContext): string | undefined {
  const type = text(trigger?.type);
  if (!trigger || !type) return undefined;
  switch (type) {
    case 'entity_event':
      return summarizeEntityEvent(trigger, ctx);
    case 'schedule':
      return summarizeSchedule(trigger, ctx);
    case 'workflow_complete':
      return summarizeWorkflowComplete(trigger, ctx);
    case 'integration_event':
      return summarizeIntegrationEvent(trigger, ctx);
    case 'webhook':
      return ctx.labels.trigger.webhook;
    case 'manual':
      return ctx.labels.trigger.manual;
    case 'api':
      return ctx.labels.trigger.api;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type ConfigSummarizer = (config: Bag, labels: NodeSummaryLabels) => string;

function clip(value: string): string {
  return value.length > 60 ? `${value.substring(0, 60)}...` : value;
}

function join(parts: string[], separator: string): string {
  return parts.filter(Boolean).join(separator);
}

function summarizeSendEmail(config: Bag, labels: NodeSummaryLabels): string {
  const to = text(config.to);
  if (!to) return '';
  return join([labels.to.replace('{to}', to), text(config.subject)], ' • ');
}

function summarizeSendNotification(config: Bag): string {
  return text(config.title);
}

function summarizeHttpRequest(config: Bag): string {
  const url = text(config.url);
  // A step stores no method until the user picks one; the engine sends GET.
  return url ? `${text(config.method) || 'GET'} ${url}` : '';
}

function summarizeCondition(config: Bag): string {
  const field = text(config.field);
  const operator = text(config.operator);
  return field && operator ? join([field, operator, text(config.value)], ' ') : '';
}

const DELAY_UNITS = ['days', 'hours', 'minutes', 'seconds'] as const;

function summarizeDelay(config: Bag, labels: NodeSummaryLabels): string {
  const unit = DELAY_UNITS.find((candidate) => Number(config[candidate]) > 0);
  if (!unit) return '';
  return labels.delay.replace('{duration}', text(config[unit])).replace('{unit}', unit);
}

function summarizeLogMessage(config: Bag): string {
  return clip(text(config.message));
}

function summarizeRecordAction(config: Bag, labels: NodeSummaryLabels): string {
  const entity = text(config.entityType) || text(config.entity);
  return entity ? labels.entity.replace('{entityType}', entity) : '';
}

function summarizeName(config: Bag): string {
  return text(config.name);
}

function summarizeContact(config: Bag): string {
  const name = join([text(config.firstName), text(config.lastName)], ' ');
  return name || text(config.email);
}

function summarizeSubject(config: Bag): string {
  return text(config.subject);
}

function summarizeMoveDealStage(config: Bag): string {
  return text(config.dealId);
}

function summarizePostChatMessage(config: Bag): string {
  return clip(text(config.message) || text(config.content));
}

function summarizeTitle(config: Bag): string {
  return text(config.title);
}

function summarizePrompt(config: Bag): string {
  return clip(text(config.prompt));
}

function summarizeSlackPostMessage(config: Bag): string {
  return clip(text(config.text));
}

function summarizeGithubCreateIssue(config: Bag): string {
  return join([text(config.repo), text(config.title)], ': ');
}

function summarizeGithubCreateComment(config: Bag): string {
  const issueNumber = config.issueNumber === undefined || config.issueNumber === null ? '' : `#${text(config.issueNumber)}`;
  return join([text(config.repo), issueNumber], ' ');
}

function summarizeGoogleSheetsRow(config: Bag): string {
  const spreadsheet = text(config.spreadsheetId);
  const sheet = text(config.sheetName);
  return spreadsheet ? `${spreadsheet}${sheet ? `!${sheet}` : ''}` : '';
}

function summarizeGmailSendEmail(config: Bag): string {
  return join([text(config.to), text(config.subject)], ': ');
}

function summarizeGoogleCalendarCreateEvent(config: Bag): string {
  return text(config.summary);
}

const CONFIG_SUMMARIZERS = new Map<string, ConfigSummarizer>([
  ['send_email', summarizeSendEmail],
  ['send_notification', summarizeSendNotification],
  ['http_request', summarizeHttpRequest],
  ['condition', summarizeCondition],
  ['delay', summarizeDelay],
  ['log_message', summarizeLogMessage],
  ['create_record', summarizeRecordAction],
  ['update_record', summarizeRecordAction],
  ['create_customer', summarizeName],
  ['create_contact', summarizeContact],
  ['update_contact', summarizeContact],
  ['create_lead', summarizeContact],
  ['create_deal', summarizeName],
  ['move_deal_stage', summarizeMoveDealStage],
  ['log_activity', summarizeSubject],
  ['post_chat_message', summarizePostChatMessage],
  ['create_task', summarizeTitle],
  ['manual_step', summarizeTitle],
  ['ai_generate', summarizePrompt],
  ['slack.post_message', summarizeSlackPostMessage],
  ['github.create_issue', summarizeGithubCreateIssue],
  ['github.create_comment', summarizeGithubCreateComment],
  ['google_sheets.append_row', summarizeGoogleSheetsRow],
  ['google_sheets.update_row', summarizeGoogleSheetsRow],
  ['gmail.send_email', summarizeGmailSendEmail],
  ['google_calendar.create_event', summarizeGoogleCalendarCreateEvent],
]);

/** The step's own summary line ("To: a@b.co"), without any "Configured" fallback. */
export function getConfigSummary(actionType: string, config: Bag, labels: NodeSummaryLabels): string {
  return CONFIG_SUMMARIZERS.get(actionType)?.(config, labels) ?? '';
}

/**
 * What an action node should say under its title: the type-specific summary
 * when there is one, "Configured" once every required field is filled in, and
 * `undefined` for a step with nothing set yet (the canvas then keeps its own
 * "Not configured").
 */
export function summarizeStep(
  step: { type: string; config?: Bag | null },
  labels: NodeSummaryLabels,
): string | undefined {
  const config = step.config ?? {};
  if (Object.keys(config).length === 0) return undefined;
  const summary = getConfigSummary(step.type, config, labels);
  if (summary) return summary;
  return isStepConfigured({ type: step.type, config }) ? labels.configured : undefined;
}
