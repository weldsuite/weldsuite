/**
 * `parse_alert`: turn a monitoring alert (Splunk, Datadog, Grafana, or
 * anything alike) into the few fields a helpdesk ticket needs, so a workflow
 * can open, escalate and close a WeldDesk conversation from an inbound
 * webhook. Pure: no I/O, and odd input (a string, an array, null) never
 * throws, it answers `success: false`.
 *
 * Mirrored by rust/modules/connect/src/engine/actions/alerts.rs: change both
 * together, the engine-run fixtures keep them honest.
 *
 * Inputs: `payload` (defaults to the trigger body), `source` (auto, splunk,
 * datadog or grafana), `defaultPriority` (low, medium, high or urgent).
 */

import type { ActionContext, ActionHandler } from '../types';

export type AlertSource = 'splunk' | 'datadog' | 'grafana' | 'generic';
export type AlertPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface ParsedAlert {
  success: true;
  source: AlertSource;
  externalId: string;
  title: string;
  message: string;
  severity: string;
  priority: AlertPriority;
  state: 'open' | 'closed';
  resolved: boolean;
  url: string;
  tags: string[];
}

export interface AlertParseFailure {
  success: false;
  error: string;
}

type Obj = Record<string, unknown>;

const URGENT = new Set(['critical', 'fatal', 'emergency', 'disaster', 'p1', 'sev1']);
const HIGH = new Set(['high', 'error', 'major', 'p2', 'sev2']);
const MEDIUM = new Set(['warning', 'warn', 'medium', 'moderate', 'p3', 'sev3']);
const LOW = new Set(['low', 'info', 'informational', 'minor', 'notice', 'debug', 'p4', 'p5', 'sev4', 'sev5']);

const RESOLVED_STATES = new Set(['resolved', 'ok', 'recovered', 'closed']);

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A scalar as trimmed text; objects and empty values give ''. */
function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** The first non-empty text among the values. */
function first(...values: unknown[]): string {
  for (const value of values) {
    const text = str(value);
    if (text) return text;
  }
  return '';
}

function obj(value: unknown): Obj {
  return isObj(value) ? value : {};
}

/** Plain string order for a sort, not locale-aware. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Severity words differ in case and punctuation ("SEV-1", "Sev 1"): compare on letters and digits. */
function severityKey(severity: string): string {
  return severity.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function severityToPriority(severity: string, fallback: AlertPriority): AlertPriority {
  const key = severityKey(severity);
  if (URGENT.has(key)) return 'urgent';
  if (HIGH.has(key)) return 'high';
  if (MEDIUM.has(key)) return 'medium';
  if (LOW.has(key)) return 'low';
  return fallback;
}

function asPriority(value: unknown): AlertPriority {
  const text = str(value).toLowerCase();
  return text === 'low' || text === 'medium' || text === 'high' || text === 'urgent' ? text : 'medium';
}

interface Fields {
  externalId: string;
  title: string;
  message: string;
  severity: string;
  resolved: boolean;
  url: string;
}

function grafana(p: Obj): Fields {
  const alerts = Array.isArray(p.alerts) ? p.alerts.filter(isObj) : [];
  const firstAlert = alerts[0] ?? {};
  const labels = obj(firstAlert.labels);
  const annotations = obj(firstAlert.annotations);
  const common = obj(p.commonLabels);
  const commonNotes = obj(p.commonAnnotations);
  const summaries = alerts.map((a) => first(obj(a.annotations).summary, obj(a.annotations).description)).filter(Boolean);
  const key = first(p.groupKey, firstAlert.fingerprint);
  return {
    externalId: key,
    title: first(p.title, commonNotes.summary, common.alertname, labels.alertname, annotations.summary),
    message: first(p.message, summaries.join('\n'), commonNotes.description, annotations.description),
    severity: first(common.severity, labels.severity),
    resolved: str(p.status).toLowerCase() === 'resolved',
    url: first(firstAlert.generatorURL, p.externalURL),
  };
}

/**
 * What makes one Datadog alert one ticket. A multi-alert monitor fires once per
 * group (host:a, host:b, ...) under one `alert_id`, so the group is part of the
 * key, and a recovery of a group lands on that group's ticket only.
 * `aggreg_key` when present, else `alert_id` plus the group (`alert_scope`, else
 * `scope`; its tags sorted, so a firing and its recovery agree), else `alert_id`,
 * else `id`.
 */
function datadogKey(p: Obj): string {
  const aggregKey = first(p.aggreg_key);
  if (aggregKey) return aggregKey;
  const alertId = first(p.alert_id);
  if (!alertId) return first(p.id);
  const scope = first(p.alert_scope, p.scope)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .sort(compareText)
    .join(',');
  return scope ? `${alertId}:${scope}` : alertId;
}

function datadog(p: Obj): Fields {
  const transition = str(p.alert_transition).toLowerCase();
  const type = str(p.alert_type).toLowerCase();
  return {
    externalId: datadogKey(p),
    title: first(p.alert_title, p.title),
    message: first(p.body, p.message, p.text, p.event_msg),
    severity: first(p.alert_priority, p.alert_type),
    resolved: transition === 'recovered' || type === 'success',
    url: first(p.link, p.url),
  };
}

function splunk(p: Obj): Fields {
  const result = obj(p.result);
  const name = first(p.search_name);
  const lines: string[] = [];
  if (name) lines.push(`Splunk alert "${name}" fired.`);
  const where = [first(p.app) && `app ${first(p.app)}`, first(p.owner) && `owner ${first(p.owner)}`].filter(Boolean);
  if (where.length > 0) lines.push(where.join(', '));
  // By field name, so the text reads the same whatever order Splunk sent them in (and in the Rust engine).
  const entries = Object.entries(result).sort(([a], [b]) => compareText(a, b));
  for (const [field, value] of entries) {
    const text = str(value);
    if (text) lines.push(`${field}: ${text}`);
  }
  return {
    externalId: name || first(p.sid),
    title: name,
    message: lines.join('\n'),
    severity: first(result.severity, result.urgency),
    resolved: false,
    url: first(p.results_link),
  };
}

function generic(p: Obj): Fields {
  const status = first(p.status, p.state).toLowerCase();
  return {
    externalId: first(p.id, p.externalId, p.fingerprint),
    title: first(p.title, p.summary, p.name),
    message: first(p.message, p.description, p.body, p.text),
    severity: first(p.severity, p.priority, p.level),
    resolved: RESOLVED_STATES.has(status),
    url: first(p.url, p.link),
  };
}

function detect(p: Obj): AlertSource {
  if (Array.isArray(p.alerts) && (p.groupKey !== undefined || p.receiver !== undefined)) return 'grafana';
  if (p.search_name !== undefined && (p.sid !== undefined || p.results_link !== undefined)) return 'splunk';
  if (['alert_transition', 'alert_type', 'aggreg_key', 'alert_id'].some((key) => p[key] !== undefined)) return 'datadog';
  return 'generic';
}

const SOURCES: ReadonlySet<string> = new Set(['splunk', 'datadog', 'grafana']);

/** How each source's payload maps onto the ticket fields. */
const READERS: Record<AlertSource, (p: Obj) => Fields> = { grafana, datadog, splunk, generic };

/** The payload as an object: an object as is, a JSON string parsed, anything else null. */
function asPayload(payload: unknown): Obj | null {
  if (isObj(payload)) return payload;
  if (typeof payload !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The widest key the conversation's `external_id` column takes. */
const EXTERNAL_ID_MAX = 255;

/** FNV-1a over the UTF-8 bytes, as 8 hex digits: a stable suffix for a key that had to be cut. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** A key over 255 characters is cut to 246 plus `~` and a hash of the whole key, so long keys stay distinct. */
export function fitExternalId(externalId: string): string {
  const chars = Array.from(externalId);
  if (chars.length <= EXTERNAL_ID_MAX) return externalId;
  return `${chars.slice(0, EXTERNAL_ID_MAX - 9).join('')}~${fnv1a(externalId)}`;
}

export function parseAlert(
  payload: unknown,
  source: string = 'auto',
  defaultPriority: AlertPriority = 'medium',
): ParsedAlert | AlertParseFailure {
  const p = asPayload(payload);
  if (!p) return { success: false, error: 'The alert payload is not a JSON object' };

  const chosen = source.toLowerCase();
  const kind: AlertSource = SOURCES.has(chosen) ? (chosen as AlertSource) : detect(p);
  const fields = READERS[kind](p);

  if (!fields.externalId && !fields.title) {
    return { success: false, error: 'The alert has neither an id nor a title' };
  }
  const title = fields.title || `${kind} alert ${fields.externalId}`;
  const link = fields.url && !fields.message.includes(fields.url) ? `\n\n${fields.url}` : '';
  return {
    success: true,
    source: kind,
    externalId: fitExternalId(`${kind}:${fields.externalId || fields.title}`),
    title,
    message: `${fields.message || title}${link}`,
    severity: fields.severity,
    priority: severityToPriority(fields.severity, defaultPriority),
    state: fields.resolved ? 'closed' : 'open',
    resolved: fields.resolved,
    url: fields.url,
    tags: [kind, 'alert'],
  };
}

function triggerBody(ctx: ActionContext): unknown {
  return isObj(ctx.triggerData) ? ctx.triggerData.body : undefined;
}

export const handleParseAlert: ActionHandler = (inputs, ctx) => {
  const given = inputs.payload;
  const payload = given === undefined || given === null || given === '' ? triggerBody(ctx) : given;
  return Promise.resolve(parseAlert(payload, str(inputs.source) || 'auto', asPriority(inputs.defaultPriority)));
};
