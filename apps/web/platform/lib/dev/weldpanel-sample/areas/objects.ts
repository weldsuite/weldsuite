/**
 * Sample answers for WeldPanel's objects: projects and keys, usage, live
 * visitors, the lexicon, people, recordings, heatmap pages, reports,
 * dashboards, cohorts, group types and groups. Everything `POST /panel/query`
 * answers (including the recordings list) lives in `query.ts`.
 *
 * Collections live in module-level arrays, so a create, update or delete shows
 * up in later reads for as long as the page stays open.
 */

import { ApiError } from '@weldsuite/api-client';
import {
  addPanelDashboardTileSchema,
  applyPanelDashboardFilters,
  createPanelCohortSchema,
  createPanelDashboardSchema,
  createPanelHeatmapPageSchema,
  createPanelKeySchema,
  createPanelReportSchema,
  favoritePanelSessionSchema,
  generatePanelSessionSummarySchema,
  setPanelDashboardLayoutSchema,
  summarisePanelSetSchema,
  updatePanelCohortSchema,
  updatePanelDashboardSchema,
  updatePanelDashboardTileSchema,
  updatePanelHeatmapPageSchema,
  updatePanelLexiconSchema,
  updatePanelReportSchema,
  type PanelActivityEvent,
  type PanelCohortDto,
  type PanelCreatedKeyDto,
  type PanelDashboardDetailDto,
  type PanelDashboardDto,
  type PanelDashboardTileDto,
  type PanelFavoriteDto,
  type PanelHeatmapPageDto,
  type PanelKeyDto,
  type PanelLexiconDto,
  type PanelLexiconEntry,
  type PanelLiveDto,
  type PanelLiveSessionDto,
  type PanelPersonDto,
  type PanelPropertyScalar,
  type PanelReportDto,
  type PanelSessionDetail,
  type PanelSessionSummary,
  type PanelSessionSummaryDto,
  type PanelSetSummaryResponse,
  type PanelUsageDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import {
  createPanelProjectSchema,
  updatePanelProjectSchema,
  updatePanelProjectSettingsSchema,
  type PanelInstallInfo,
  type PanelProjectDto,
} from '@weldsuite/app-api-client/schemas/weldpanel';
import {
  createPanelDashboardFromTemplateSchema,
  PANEL_TEMPLATE_LOCALES,
  type PanelTemplateLocale,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import {
  createPanelGroupTypeSchema,
  PANEL_MAX_GROUP_TYPES,
  updatePanelGroupTypeSchema,
  type PanelGroupDto,
  type PanelGroupMemberDto,
  type PanelGroupProfileDto,
  type PanelGroupTypeDto,
} from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { UNHANDLED, type SampleAreaHandler, type SampleRequest } from '../request';
import {
  APP_PROJECT_ID,
  APP_SCREENS,
  COMPANIES,
  EVENTS,
  MEMBERS,
  PAGES,
  PEOPLE,
  PROJECTS,
  SESSIONS,
  WEBSITE_PROJECT_ID,
  between,
  data,
  isoDaysAgo,
  isoMinutesAgo,
  personById,
  pick,
  rng,
  sampleId,
  today,
  ymd,
  type SamplePerson,
  type SampleSession,
} from '../dataset';
import { chunkManifest, jsonResponse, replayFor, snapshotEvent, titleOf } from './objects-replay';
import { defaultSpec, seedCohorts, seedDashboards, seedReports, templateDtos, templateSeed, type TileSeed } from './objects-specs';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ME = MEMBERS[0].userId;

function fail(status: number, code: string, message: string): never {
  throw new ApiError(message, status, { error: { code, message } });
}

function notFound(what: string): never {
  return fail(404, 'NOT_FOUND', `${what} not found`);
}

/** Validates a request body with one of the contract's schemas; a bad body is a 400, as from the API. */
function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) return fail(400, 'VALIDATION_ERROR', result.error.issues[0]?.message ?? 'Invalid request');
  return result.data;
}

function nowIso(): string {
  return new Date().toISOString();
}

function projectName(id: string): string {
  return projects.find((p) => p.id === id)?.name ?? 'Project';
}

function paginate<T>(items: T[], query: URLSearchParams, defaultLimit = 50) {
  const limit = Math.max(1, Math.min(100, Number(query.get('limit')) || defaultLimit));
  const cursor = query.get('cursor');
  const offset = cursor?.startsWith('o:') ? Number(cursor.slice(2)) || 0 : 0;
  const hasMore = offset + limit < items.length;
  return { data: items.slice(offset, offset + limit), pagination: { totalCount: items.length, hasMore, cursor: hasMore ? `o:${offset + limit}` : null } };
}

function listOf<T>(items: T[]) {
  return { data: items, pagination: { totalCount: items.length, hasMore: false, cursor: null } };
}

function randomToken(length: number): string {
  let out = '';
  while (out.length < length) out += Math.random().toString(36).slice(2);
  return out.slice(0, length);
}

function sortNewest<T extends { updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------------------------------------------------------------------------
// Projects, install check and keys
// ---------------------------------------------------------------------------

const projects: PanelProjectDto[] = PROJECTS.map((p) => ({ ...p, allowedDomains: [...p.allowedDomains], settings: { ...p.settings, excludedUrls: [...p.settings.excludedUrls], ipFilters: [...p.settings.ipFilters] } }));
/** Projects made in this session haven't received an event yet. */
const waitingProjects = new Set<string>();

const keys: PanelKeyDto[] = [
  { id: 'pnk_sample_1', projectId: WEBSITE_PROJECT_ID, name: 'Server-side sign-ups', prefix: 'wps_8f2a', createdByUserId: MEMBERS[0].userId, createdAt: isoDaysAgo(120), lastUsedAt: isoMinutesAgo(14), revokedAt: null },
  { id: 'pnk_sample_2', projectId: WEBSITE_PROJECT_ID, name: 'CRM import', prefix: 'wps_c41d', createdByUserId: MEMBERS[1].userId, createdAt: isoDaysAgo(64), lastUsedAt: isoDaysAgo(9), revokedAt: null },
  { id: 'pnk_sample_3', projectId: WEBSITE_PROJECT_ID, name: 'Old backfill script', prefix: 'wps_03be', createdByUserId: MEMBERS[2].userId, createdAt: isoDaysAgo(200), lastUsedAt: isoDaysAgo(150), revokedAt: isoDaysAgo(140) },
  { id: 'pnk_sample_4', projectId: APP_PROJECT_ID, name: 'Billing events', prefix: 'wps_5d90', createdByUserId: MEMBERS[3].userId, createdAt: isoDaysAgo(95), lastUsedAt: isoMinutesAgo(3), revokedAt: null },
  { id: 'pnk_sample_5', projectId: APP_PROJECT_ID, name: 'Warehouse export', prefix: 'wps_a7e2', createdByUserId: MEMBERS[0].userId, createdAt: isoDaysAgo(31), lastUsedAt: null, revokedAt: null },
];

function findProject(id: string): PanelProjectDto {
  return projects.find((p) => p.id === id) ?? notFound('Project');
}

function installInfo(project: PanelProjectDto): PanelInstallInfo {
  const waiting = waitingProjects.has(project.id);
  return {
    projectId: project.id,
    token: project.token,
    collectorUrl: 'https://pnl.weldsuite.org',
    scriptSnippet: `<script>!function(w,d){w.weldpanel=w.weldpanel||[];["track","identify","group","page"].forEach(function(m){w.weldpanel[m]=function(){w.weldpanel.push([m].concat([].slice.call(arguments)))}})}(window,document);</script>\n<script async src="https://pnl.weldsuite.org/s.js" data-project="${project.token}"></script>`,
    npmSnippet: `npm install @weldsuite/panel-sdk\n\nimport { weldpanel } from '@weldsuite/panel-sdk';\n\nweldpanel.init('${project.token}');`,
    lastEventAt: waiting ? null : isoMinutesAgo(project.kind === 'app' ? 1 : 3),
    status: waiting ? 'waiting' : 'receiving',
  };
}

function handleProjects(req: SampleRequest): unknown {
  const { method, segments: s } = req;
  if (s[0] !== 'projects') return UNHANDLED;
  if (s.length === 1) {
    if (method === 'GET') return listOf(projects);
    if (method === 'POST') {
      const input = parse(createPanelProjectSchema, req.body);
      const project: PanelProjectDto = {
        id: sampleId('pnp'),
        name: input.name,
        kind: input.kind,
        status: 'active',
        token: `wpk_${randomToken(12)}`,
        allowedDomains: input.allowedDomains,
        settings: { autocapture: true, maskingLevel: 'balanced', consentMode: 'required', recordingSampleRate: 1, excludedUrls: [], ipFilters: [], aiEnabled: false },
        createdByUserId: ME,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      projects.push(project);
      waitingProjects.add(project.id);
      return data(project);
    }
    return UNHANDLED;
  }
  const project = findProject(s[1]!);
  if (s.length === 2) {
    if (method === 'GET') return data(project);
    if (method === 'PATCH') {
      const input = parse(updatePanelProjectSchema, req.body);
      Object.assign(project, input, { updatedAt: nowIso() });
      return data(project);
    }
    if (method === 'DELETE') {
      projects.splice(projects.indexOf(project), 1);
      return undefined;
    }
    return UNHANDLED;
  }
  if (s.length === 3 && s[2] === 'settings' && method === 'PATCH') {
    const input = parse(updatePanelProjectSettingsSchema, req.body);
    if (input.status) project.status = input.status;
    if (input.settings) project.settings = { ...project.settings, ...input.settings };
    project.updatedAt = nowIso();
    return data(project);
  }
  if (s.length === 3 && s[2] === 'rotate-token' && method === 'POST') {
    project.token = `wpk_${randomToken(12)}`;
    project.updatedAt = nowIso();
    return data(project);
  }
  if (s.length === 3 && s[2] === 'install' && method === 'GET') return data(installInfo(project));
  if (s[2] === 'keys') {
    if (s.length === 3 && method === 'GET') return listOf(keys.filter((k) => k.projectId === project.id));
    if (s.length === 3 && method === 'POST') {
      const input = parse(createPanelKeySchema, req.body);
      const secret = `wps_${randomToken(40)}`;
      const created: PanelCreatedKeyDto = { id: sampleId('pnk'), projectId: project.id, name: input.name, prefix: secret.slice(0, 8), createdByUserId: ME, createdAt: nowIso(), lastUsedAt: null, revokedAt: null, key: secret };
      const { key: _secret, ...stored } = created;
      void _secret;
      keys.unshift(stored);
      return data(created);
    }
    if (s.length === 4 && method === 'DELETE') {
      const key = keys.find((k) => k.id === s[3] && k.projectId === project.id) ?? notFound('Key');
      key.revokedAt = nowIso();
      return undefined;
    }
  }
  return UNHANDLED;
}

// ---------------------------------------------------------------------------
// Usage and live visitors
// ---------------------------------------------------------------------------

function usage(): PanelUsageDto {
  const siteEvents = 812_400;
  const appEvents = 1_067_900;
  return {
    month: ymd(today()).slice(0, 7),
    planSlug: 'business',
    events: { used: siteEvents + appEvents, allowance: 2_000_000, blocksCharged: 0, creditsCharged: 0 },
    recordings: { used: 11_380, allowance: 10_000, blocksCharged: 2, creditsCharged: 40 },
    quota: 'ok',
    retention: { eventsMonths: 12, recordingsDays: 90, favoritesMonths: 12 },
    projects: [
      { projectId: WEBSITE_PROJECT_ID, name: projectName(WEBSITE_PROJECT_ID), events: siteEvents, recordings: 7_940 },
      { projectId: APP_PROJECT_ID, name: projectName(APP_PROJECT_ID), events: appEvents, recordings: 3_440 },
    ],
  };
}

function live(projectId: string): PanelLiveDto {
  const bucket = Math.floor(Date.now() / 15_000);
  const random = rng(`live|${projectId}|${bucket}`);
  const app = projectId === APP_PROJECT_ID;
  const pool = app ? APP_SCREENS : PAGES;
  const count = between(random, 11, 19);
  const sessions: PanelLiveSessionDto[] = Array.from({ length: count }, (_, i) => {
    const person = random() < 0.45 ? PEOPLE[Math.floor(random() * PEOPLE.length)]! : null;
    const page = pick(random, pool, pool.map((p) => p.weight));
    const startedSecondsAgo = between(random, 20, 1100);
    return {
      sessionId: `ses_live_${projectId.slice(-4)}_${i}_${Math.floor(bucket / 40)}`,
      distinctId: person?.distinctId ?? `anon_${Math.floor(random() * 1e8).toString(36)}`,
      path: page.path,
      title: page.title,
      country: person?.country ?? pick(random, ['NL', 'DE', 'US', 'BE', 'GB', 'FR', 'ES'], [30, 14, 14, 8, 8, 5, 3]),
      deviceType: person ? (person.device as PanelLiveSessionDto['deviceType']) : pick(random, ['desktop', 'mobile', 'tablet'] as const, [66, 29, 5]),
      ts: new Date(Date.now() - between(random, 1, 80) * 1000).toISOString(),
      startedAt: new Date(Date.now() - startedSecondsAgo * 1000).toISOString(),
      pageviews: Math.max(1, Math.round(startedSecondsAgo / 90) + between(random, 0, 2)),
    };
  }).sort((a, b) => b.ts.localeCompare(a.ts));
  return { projectId, visitors: sessions.length, sessions };
}

// ---------------------------------------------------------------------------
// Lexicon
// ---------------------------------------------------------------------------

interface LexiconOverride {
  description?: string | null;
  hidden?: boolean;
  verified?: boolean;
  definitionId?: string;
}
const lexiconOverrides = new Map<string, LexiconOverride>();

const EXTRA_EVENTS: ReadonlyArray<{ name: string; description: string | null; site: number; app: number }> = [
  { name: '$webvitals', description: 'Loading speed measurements from the browser', site: 3900, app: 0 },
  { name: '$rageclick', description: 'Several fast clicks in the same spot', site: 38, app: 120 },
  { name: '$deadclick', description: 'A click that did nothing', site: 74, app: 210 },
  { name: '$exception', description: 'An error thrown in the browser', site: 22, app: 330 },
  { name: '$identify', description: 'A visitor was linked to a person', site: 150, app: 1900 },
  { name: 'pricing_plan_selected', description: null, site: 95, app: 0 },
  { name: 'export_downloaded', description: null, site: 0, app: 74 },
];

/** Events and properties that someone described before they were ever sent. */
const PLANNED_EVENTS = [
  { name: 'referral_link_shared', description: 'Planned for the referral programme in Q1' },
  { name: 'onboarding_checklist_completed', description: 'Finished every step of the checklist' },
];

const PROPERTIES: ReadonlyArray<{ name: string; description: string | null; count: number; verified?: boolean; hidden?: boolean }> = [
  { name: '$current_url', description: 'The full address of the page', count: 1_940_000, verified: true },
  { name: '$pathname', description: 'The path of the page, without the host', count: 1_940_000, verified: true },
  { name: '$referring_domain', description: 'The site the visitor came from', count: 1_210_000, verified: true },
  { name: '$browser', description: 'Chrome, Safari, Firefox and so on', count: 1_940_000, verified: true },
  { name: '$os', description: 'Operating system', count: 1_940_000, verified: true },
  { name: '$device_type', description: 'Desktop, mobile or tablet', count: 1_940_000, verified: true },
  { name: '$screen_width', description: null, count: 1_940_000 },
  { name: '$email', description: 'The email address a visitor signed up with', count: 84_300, verified: true },
  { name: '$name', description: 'The visitor’s full name', count: 84_300 },
  { name: 'utm_source', description: 'Where the campaign ran', count: 402_000, verified: true },
  { name: 'utm_medium', description: 'The kind of channel: email, cpc, social', count: 402_000, verified: true },
  { name: 'utm_campaign', description: 'The campaign name', count: 402_000, verified: true },
  { name: 'plan', description: 'The plan of the workspace: free, trial, starter, business or enterprise', count: 311_000, verified: true },
  { name: 'company', description: 'The name of the visitor’s company', count: 84_300 },
  { name: 'role', description: null, count: 61_900 },
  { name: 'seats', description: 'Number of paid users in the workspace', count: 58_400 },
  { name: 'invoice_total', description: 'Total of an invoice, in euros', count: 6_900 },
  { name: 'module', description: 'The module a visitor installed or opened', count: 72_000 },
  { name: 'source', description: null, count: 143_000 },
  { name: '$sdk_version', description: 'Internal, from the SDK', count: 1_940_000, hidden: true },
];

function lexicon(projectId: string): PanelLexiconDto {
  const app = projectId === APP_PROJECT_ID;
  const entry = (kind: 'event' | 'property', name: string, count: number | null, seen: boolean, description: string | null, verified: boolean, hidden: boolean): PanelLexiconEntry => {
    const o = lexiconOverrides.get(`${projectId}|${kind}|${name}`);
    const hasDefinition = description !== null || verified || hidden || o !== undefined;
    return {
      name,
      seen,
      count30d: count,
      description: o?.description !== undefined ? o.description : description,
      hidden: o?.hidden ?? hidden,
      verified: o?.verified ?? verified,
      definitionId: o?.definitionId ?? (hasDefinition ? `pnd_${kind.slice(0, 1)}_${name.replace(/[^a-z0-9]/gi, '').slice(0, 14)}` : null),
    };
  };
  const events: PanelLexiconEntry[] = [];
  for (const e of EVENTS) {
    const perDay = app ? e.perDay.app : e.perDay.site;
    if (perDay <= 0) continue;
    events.push(entry('event', e.name, perDay * 30, true, e.description, !e.name.startsWith('$autocapture') && e.name !== 'newsletter_subscribed', false));
  }
  for (const e of EXTRA_EVENTS) {
    const perDay = app ? e.app : e.site;
    if (perDay <= 0) continue;
    events.push(entry('event', e.name, perDay * 30, true, e.description, false, false));
  }
  for (const e of PLANNED_EVENTS) events.push(entry('event', e.name, 0, false, e.description, false, false));
  const properties = PROPERTIES.map((p) => entry('property', p.name, Math.round(p.count * (app ? 0.7 : 0.4)), true, p.description, p.verified ?? false, p.hidden ?? false));
  return { events: events.sort((a, b) => (b.count30d ?? 0) - (a.count30d ?? 0)), properties, scannedAt: isoMinutesAgo(38) };
}

function handleLexicon(req: SampleRequest): unknown {
  if (req.segments[0] !== 'lexicon' || req.segments.length !== 1) return UNHANDLED;
  if (req.method === 'GET') return data(lexicon(req.query.get('projectId') ?? WEBSITE_PROJECT_ID));
  if (req.method === 'PATCH') {
    const input = parse(updatePanelLexiconSchema, req.body);
    const key = `${input.projectId}|${input.kind}|${input.name}`;
    const prior = lexiconOverrides.get(key) ?? { definitionId: sampleId('pnd') };
    const next: LexiconOverride = { ...prior };
    if (input.description !== undefined) next.description = input.description;
    if (input.hidden !== undefined) next.hidden = input.hidden;
    if (input.verified !== undefined) next.verified = input.verified;
    lexiconOverrides.set(key, next);
    const list = lexicon(input.projectId);
    const found = (input.kind === 'event' ? list.events : list.properties).find((e) => e.name === input.name);
    return data(found ?? { name: input.name, seen: false, count30d: null, description: next.description ?? null, hidden: next.hidden ?? false, verified: next.verified ?? false, definitionId: next.definitionId ?? null });
  }
  return UNHANDLED;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const erasedPeople = new Set<string>();

function anonIdsOf(person: SamplePerson): string[] {
  const random = rng(`anon|${person.distinctId}`);
  return Array.from({ length: between(random, 1, 3) }, () => `anon_${Math.floor(random() * 1e8).toString(36)}`);
}

function personDto(person: SamplePerson): PanelPersonDto {
  const company = COMPANIES.find((c) => c.name === person.company);
  const properties: Record<string, PanelPropertyScalar> = {
    $email: person.email,
    $name: person.name,
    company: person.company,
    role: person.role,
    plan: person.plan,
    country: person.country,
    city: person.city,
    $browser: person.browser,
    $os: person.os,
    $device_type: person.device,
    seats: company ? Math.max(1, Math.round(company.employees / 6)) : 3,
    is_admin: person.role === 'Founder' || person.role === 'CEO',
  };
  return { userId: person.distinctId, email: person.email, name: person.name, properties, anonIds: anonIdsOf(person), firstSeen: person.firstSeen, lastSeen: person.lastSeen };
}

function visiblePeople(): SamplePerson[] {
  return PEOPLE.filter((p) => !erasedPeople.has(p.distinctId)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function inCohort(person: SamplePerson, cohortId: string): boolean {
  switch (cohortId) {
    case 'coh_sample_power':
      return person.plan === 'business' || person.plan === 'enterprise';
    case 'coh_sample_trials':
      return person.plan === 'trial' || Date.now() - Date.parse(person.firstSeen) < 30 * 86_400_000;
    case 'coh_sample_at_risk':
      return person.plan !== 'free' && Date.now() - Date.parse(person.lastSeen) > 7 * 86_400_000;
    case 'coh_sample_nl_smb':
      return person.country === 'NL';
    default:
      return rng(`${cohortId}|${person.distinctId}`)() < 0.35;
  }
}

const FAVORITES = new Map<string, PanelFavoriteDto>();
const SUMMARIES = new Map<string, PanelSessionSummaryDto>();

function sessionRow(s: SampleSession, overrides: { distinctId?: string; userId?: string | null } = {}): PanelSessionRow {
  const random = rng(`row|${s.sessionId}`);
  const start = Date.parse(s.startedAt);
  const replay = replayFor(s.sessionId);
  return {
    sessionId: s.sessionId,
    startedAt: s.startedAt,
    endedAt: new Date(start + s.durationSeconds * 1000).toISOString(),
    durationSeconds: s.durationSeconds,
    pageviews: s.pageviews,
    clicks: Math.max(replay.activity.filter((e) => e.name === '$autocapture').length, Math.round(s.events * (0.2 + random() * 0.2))),
    events: s.events,
    rageClicks: s.rageClicks,
    deadClicks: s.deadClicks,
    quickBacks: s.pageviews > 4 && s.rageClicks === 0 ? between(random, 0, 1) : 0,
    excessiveScrolls: s.durationSeconds > 400 && random() < 0.25 ? 1 : 0,
    errors: s.errors,
    entryPage: s.entryPath,
    exitPage: s.exitPath,
    deviceType: s.device === 'mobile' || s.device === 'tablet' ? s.device : 'desktop',
    browser: s.browser,
    os: s.os,
    country: s.country,
    distinctId: overrides.distinctId ?? s.distinctId ?? s.anonymousId,
    userId: overrides.userId !== undefined ? overrides.userId : s.distinctId,
    hasRecording: true,
    chunkCount: replay.chunks.length,
    favorite: FAVORITES.has(s.sessionId),
  };
}

/** A person's sessions: the recorded ones that are theirs, else a couple lent from the pool so the profile isn't bare. */
function sessionsOfPerson(person: SamplePerson): PanelSessionRow[] {
  const own = SESSIONS.filter((s) => s.distinctId === person.distinctId);
  if (own.length > 0) return own.map((s) => sessionRow(s));
  const index = PEOPLE.indexOf(person);
  return [SESSIONS[(index * 3 + 2) % SESSIONS.length]!, SESSIONS[(index * 7 + 5) % SESSIONS.length]!].map((s) => sessionRow(s, { distinctId: person.distinctId, userId: person.distinctId }));
}

const CUSTOM_EVENT_NAMES = EVENTS.filter((e) => !e.name.startsWith('$')).map((e) => e.name);

function makeEvent(random: () => number, key: string, name: string, ts: number, app: boolean): PanelActivityEvent {
  const pool = app ? APP_SCREENS : PAGES;
  const page = pick(random, pool, pool.map((p) => p.weight));
  const custom = !name.startsWith('$');
  return {
    eventId: `${key}_${Math.floor(random() * 1e9).toString(36)}`,
    name,
    ts: new Date(ts).toISOString(),
    path: page.path,
    url: `https://${app ? 'app.weldsuite.org' : 'weldsuite.com'}${page.path}`,
    title: page.title,
    sessionId: null,
    detail: name === '$autocapture' ? `Clicked '${pick(random, ['Start free trial', 'Pricing', 'Save', 'New ticket', 'Send invoice', 'Invite teammate'])}'` : null,
    properties: custom ? { plan: pick(random, ['trial', 'starter', 'business']), source: pick(random, ['pricing_page', 'blog', 'app']) } : {},
  };
}

function eventsOfPerson(person: SamplePerson, sessions: PanelSessionRow[], count = 40): PanelActivityEvent[] {
  const fromSessions = sessions.flatMap((row) => replayFor(row.sessionId).activity.map((e) => ({ ...e, sessionId: row.sessionId })));
  const random = rng(`events|${person.distinctId}`);
  const lastSeen = Date.parse(person.lastSeen);
  const filler = Array.from({ length: Math.max(0, count - fromSessions.length) }, (_, i) => {
    const name = pick(random, ['$pageview', '$autocapture', ...CUSTOM_EVENT_NAMES], [8, 6, ...CUSTOM_EVENT_NAMES.map(() => 1)]);
    return makeEvent(random, `${person.distinctId}_${i}`, name, lastSeen - between(random, 3, 60) * 3_600_000 * (1 + i * 0.3), true);
  });
  return [...fromSessions, ...filler].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, count);
}

function handlePeople(req: SampleRequest): unknown {
  const { method, segments: s, query } = req;
  if (s[0] !== 'people') return UNHANDLED;
  if (s.length === 1 && method === 'GET') {
    const search = (query.get('search') ?? '').trim().toLowerCase();
    const cohortId = query.get('cohortId');
    let people = visiblePeople();
    if (search) people = people.filter((p) => `${p.name} ${p.email} ${p.company} ${p.distinctId}`.toLowerCase().includes(search));
    if (cohortId) people = people.filter((p) => inCohort(p, cohortId));
    return paginate(people.map(personDto), query, 50);
  }
  if (s.length === 2 && s[1] === 'by-email' && method === 'GET') {
    const email = (query.get('email') ?? '').trim().toLowerCase();
    const person = visiblePeople().find((p) => p.email.toLowerCase() === email);
    if (!person) return data({ people: [] });
    return data({
      people: PROJECTS.map((project) => {
        const sessions = sessionsOfPerson(person);
        return { projectId: project.id, projectName: projectName(project.id), person: personDto(person), recentEvents: eventsOfPerson(person, sessions, 12), sessions };
      }),
    });
  }
  if (s.length === 2) {
    const person = personById(s[1]!);
    if (method === 'GET') {
      if (!person || erasedPeople.has(person.distinctId)) return notFound('Person');
      const sessions = sessionsOfPerson(person);
      return data({ projectId: query.get('projectId') ?? WEBSITE_PROJECT_ID, person: personDto(person), recentEvents: eventsOfPerson(person, sessions), sessions, eventCount90d: person.pageviews * 3 + person.sessions });
    }
    if (method === 'DELETE') {
      if (person) erasedPeople.add(person.distinctId);
      return data({ userId: person?.distinctId ?? null, erasedIdCount: person ? anonIdsOf(person).length + 1 : 0, recordingChunksDeleted: person ? sessionsOfPerson(person).reduce((n, r) => n + r.chunkCount, 0) : 0 });
    }
  }
  return UNHANDLED;
}

// ---------------------------------------------------------------------------
// Sessions, recordings and summaries
// ---------------------------------------------------------------------------

function buildSummary(session: SampleSession, projectId: string): PanelSessionSummaryDto {
  const outcome: PanelSessionSummary['outcome'] = session.pages.some((p) => p === '/signup') ? 'succeeded' : session.pageviews === 1 ? 'unclear' : session.rageClicks > 0 || session.errors > 0 ? 'abandoned' : 'succeeded';
  const entry = titleOf(session.entryPath).replace(/ · .*$/, '');
  const friction: string[] = [];
  if (session.rageClicks > 0) friction.push('Clicked the “Book a demo” button several times in a row; nothing seemed to happen.');
  if (session.deadClicks > 0) friction.push('Clicked a heading that looks like a link but is not one.');
  if (session.errors > 0) friction.push('A page error appeared near the end of the visit.');
  if (session.pages.filter((p) => p === '/pricing').length > 1) friction.push('Went back to the pricing page more than once, which suggests the plans were hard to compare.');
  const goalByPath: Record<string, string> = {
    '/': 'Find out what WeldSuite does and whether it fits a small team.',
    '/pricing': 'Compare plans and prices.',
    '/signup': 'Create an account.',
    '/login': 'Sign in to an existing workspace.',
    '/contact': 'Get in touch with sales.',
  };
  return {
    id: sampleId('pnss'),
    projectId,
    sessionId: session.sessionId,
    summary: {
      goal: goalByPath[session.entryPath] ?? `Read about ${entry.toLowerCase()} and decide whether to try it.`,
      outcome,
      frictionPoints: friction,
      narrative: `The visitor arrived from ${session.referrerHost === '(direct)' ? 'a direct visit' : session.referrerHost} on ${entry}. They viewed ${session.pageviews} page${session.pageviews === 1 ? '' : 's'} over ${Math.max(1, Math.round(session.durationSeconds / 60))} minute${session.durationSeconds >= 90 ? 's' : ''}${outcome === 'succeeded' ? ' and reached the sign-up form.' : outcome === 'abandoned' ? ' and left before finishing what they came for.' : ' and left without doing anything further.'}`,
    },
    modelId: 'claude-haiku-4-5',
    creditsCharged: 2,
    createdAt: nowIso(),
  };
}

function findSession(id: string): SampleSession | undefined {
  return SESSIONS.find((s) => s.sessionId === id);
}

function sessionDetail(projectId: string, session: SampleSession): PanelSessionDetail {
  const person = session.distinctId ? personById(session.distinctId) : undefined;
  const replay = replayFor(session.sessionId);
  const others = person ? SESSIONS.filter((s) => s.distinctId === person.distinctId && s.sessionId !== session.sessionId).map((s) => sessionRow(s)) : [];
  return {
    projectId,
    session: sessionRow(session),
    person: person ? personDto(person) : null,
    chunks: chunkManifest(session.sessionId),
    events: replay.activity,
    favorite: FAVORITES.get(session.sessionId) ?? null,
    summary: SUMMARIES.get(session.sessionId) ?? null,
    otherSessions: others.length > 0 ? others : SESSIONS.filter((s) => s.sessionId !== session.sessionId && s.distinctId === null).slice(0, 2).map((s) => sessionRow(s)),
  };
}

// Pre-made summaries and favourites, so the recordings list isn't blank.
for (const s of SESSIONS.filter((_, i) => i % 6 === 1).slice(0, 8)) SUMMARIES.set(s.sessionId, { ...buildSummary(s, WEBSITE_PROJECT_ID), createdAt: isoDaysAgo(1) });
SESSIONS.filter((_, i) => i % 11 === 4)
  .slice(0, 4)
  .forEach((s, i) => FAVORITES.set(s.sessionId, { id: `pnf_sample_${i}`, projectId: WEBSITE_PROJECT_ID, sessionId: s.sessionId, note: ['Good example of the pricing confusion.', 'Shows the sign-up form error.', null, 'Share with the design team.'][i] ?? null, favoritedByUserId: MEMBERS[i % MEMBERS.length].userId, createdAt: isoDaysAgo(i + 1) }));

function setSummary(input: ReturnType<typeof summarisePanelSetSchema.parse>): PanelSetSummaryResponse {
  const pool = input.source.type === 'sessions' && input.source.spec.sessionIds?.length ? SESSIONS.filter((s) => input.source.type === 'sessions' && input.source.spec.sessionIds?.includes(s.sessionId)) : SESSIONS;
  const read = (pool.length > 0 ? pool : SESSIONS).slice(0, input.limit);
  const third = Math.max(1, Math.floor(read.length / 3));
  const group = (from: number, to: number) => read.slice(from, to).map((s) => s.sessionId);
  const themes = [
    { title: 'People compare plans and leave', description: 'Several visitors opened the pricing page two or three times, scrolled between the plans and left without picking one. The feature list under each plan is the part they spent most time on.', sessionIds: group(0, third) },
    { title: 'The “Book a demo” button looks broken', description: 'A handful of visitors clicked it repeatedly. On mobile it sits below the fold and does not respond to taps until the page has finished loading.', sessionIds: group(third, third * 2) },
    { title: 'Sign-up goes smoothly for returning visitors', description: 'Visitors who had been on the site before went straight from the home page to sign-up and finished in under two minutes.', sessionIds: group(third * 2, read.length) },
  ].filter((t) => t.sessionIds.length > 0);
  return {
    id: sampleId('pnis'),
    projectId: input.projectId,
    summary: {
      overview: input.source.type === 'funnel_drop_off' ? `Of the ${read.length} people who dropped off after this step, most were comparing options. A smaller group ran into a button that did not respond.` : `Across ${read.length} recordings, the main pattern is hesitation around pricing, with a smaller group hitting a button that does not respond.`,
      themes: themes.map((t) => ({ ...t, sessionCount: t.sessionIds.length })),
      sessionsRead: read.length,
    },
    modelId: 'claude-sonnet-4-5',
    creditsCharged: 6,
    cached: false,
    createdAt: nowIso(),
  };
}

function handleSessions(req: SampleRequest): unknown {
  const { method, segments: s, query } = req;
  if (s[0] === 'insights' && s[1] === 'summarise' && s.length === 2 && method === 'POST') return data(setSummary(parse(summarisePanelSetSchema, req.body)));
  if (s[0] !== 'sessions' || s.length < 2) return UNHANDLED;
  const sessionId = s[1]!;
  const projectId = query.get('projectId') ?? WEBSITE_PROJECT_ID;
  const session = findSession(sessionId);
  if (s.length === 2 && method === 'GET') return session ? data(sessionDetail(projectId, session)) : notFound('Session');
  if (s.length === 4 && s[2] === 'chunks' && method === 'GET') {
    const chunk = session ? replayFor(sessionId).chunks.find((c) => c.seq === Number(s[3])) : undefined;
    if (!chunk) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Chunk not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return jsonResponse(chunk.events);
  }
  if (s.length === 3 && s[2] === 'favorite') {
    if (method === 'PUT') {
      const input = parse(favoritePanelSessionSchema, req.body);
      const favorite: PanelFavoriteDto = FAVORITES.get(sessionId) ?? { id: sampleId('pnf'), projectId: input.projectId, sessionId, note: null, favoritedByUserId: ME, createdAt: nowIso() };
      favorite.note = input.note ?? null;
      FAVORITES.set(sessionId, favorite);
      return data(favorite);
    }
    if (method === 'DELETE') {
      FAVORITES.delete(sessionId);
      return undefined;
    }
  }
  if (s.length === 3 && s[2] === 'summary') {
    if (method === 'GET') return data(SUMMARIES.get(sessionId) ?? null);
    if (method === 'POST') {
      const input = parse(generatePanelSessionSummarySchema, req.body);
      const cached = SUMMARIES.get(sessionId);
      if (cached && !input.regenerate) return data({ ...cached, cached: true });
      const made = buildSummary(session ?? SESSIONS[0]!, input.projectId);
      SUMMARIES.set(sessionId, made);
      return data({ ...made, cached: false });
    }
  }
  return UNHANDLED;
}

// ---------------------------------------------------------------------------
// Heatmap pages and snapshots
// ---------------------------------------------------------------------------

const heatmapPages: PanelHeatmapPageDto[] = [
  { id: 'pnhp_sample_home', projectId: WEBSITE_PROJECT_ID, name: 'Home page', urlPattern: '/', createdByUserId: MEMBERS[1].userId, createdAt: isoDaysAgo(110), updatedAt: isoDaysAgo(110) },
  { id: 'pnhp_sample_pricing', projectId: WEBSITE_PROJECT_ID, name: 'Pricing', urlPattern: '/pricing', createdByUserId: MEMBERS[0].userId, createdAt: isoDaysAgo(96), updatedAt: isoDaysAgo(30) },
  { id: 'pnhp_sample_features', projectId: WEBSITE_PROJECT_ID, name: 'Feature pages', urlPattern: '/features/*', createdByUserId: MEMBERS[1].userId, createdAt: isoDaysAgo(70), updatedAt: isoDaysAgo(70) },
  { id: 'pnhp_sample_signup', projectId: WEBSITE_PROJECT_ID, name: 'Sign-up', urlPattern: '/signup', createdByUserId: MEMBERS[2].userId, createdAt: isoDaysAgo(52), updatedAt: isoDaysAgo(52) },
  { id: 'pnhp_sample_blog', projectId: WEBSITE_PROJECT_ID, name: 'Blog posts', urlPattern: '/blog/*', createdByUserId: MEMBERS[1].userId, createdAt: isoDaysAgo(20), updatedAt: isoDaysAgo(20) },
  { id: 'pnhp_sample_app_home', projectId: APP_PROJECT_ID, name: 'Home', urlPattern: '/home', createdByUserId: MEMBERS[3].userId, createdAt: isoDaysAgo(60), updatedAt: isoDaysAgo(60) },
  { id: 'pnhp_sample_app_tickets', projectId: APP_PROJECT_ID, name: 'Tickets', urlPattern: '/welddesk/tickets', createdByUserId: MEMBERS[3].userId, createdAt: isoDaysAgo(41), updatedAt: isoDaysAgo(41) },
];

function pathForPattern(pattern: string): string {
  if (pattern === '/features/*') return '/features/crm';
  if (pattern === '/blog/*') return '/blog/replacing-ten-tools-with-one';
  if (pattern === '/docs/*') return '/docs/getting-started';
  const cleaned = pattern.replace(/\*+/g, '').replace(/\/+$/, '');
  return cleaned === '' ? '/' : cleaned;
}

function handleHeatmaps(req: SampleRequest): unknown {
  const { method, segments: s, query } = req;
  if (s[0] !== 'heatmaps' || s[1] !== 'pages') return UNHANDLED;
  if (s.length === 2) {
    if (method === 'GET') return listOf(heatmapPages.filter((p) => p.projectId === (query.get('projectId') ?? WEBSITE_PROJECT_ID)));
    if (method === 'POST') {
      const input = parse(createPanelHeatmapPageSchema, req.body);
      const page: PanelHeatmapPageDto = { id: sampleId('pnhp'), projectId: input.projectId, name: input.name, urlPattern: input.urlPattern, createdByUserId: ME, createdAt: nowIso(), updatedAt: nowIso() };
      heatmapPages.push(page);
      return data(page);
    }
    return UNHANDLED;
  }
  const page = heatmapPages.find((p) => p.id === s[2]);
  if (s.length === 3) {
    if (!page) return notFound('Page group');
    if (method === 'PATCH') {
      Object.assign(page, parse(updatePanelHeatmapPageSchema, req.body), { updatedAt: nowIso() });
      return data(page);
    }
    if (method === 'DELETE') {
      heatmapPages.splice(heatmapPages.indexOf(page), 1);
      return undefined;
    }
  }
  if (s.length === 4 && s[3] === 'snapshot' && method === 'GET') {
    const path = pathForPattern(page?.urlPattern ?? '/');
    return jsonResponse(snapshotEvent(path, Date.now() - 3_600_000));
  }
  return UNHANDLED;
}

// ---------------------------------------------------------------------------
// Reports, dashboards and cohorts
// ---------------------------------------------------------------------------

const reports: PanelReportDto[] = seedReports();
const seededDashboards = seedDashboards();
const dashboards: PanelDashboardDto[] = seededDashboards.dashboards;
const tiles: TileSeed[] = seededDashboards.tiles;
const cohorts: PanelCohortDto[] = seedCohorts();
const SEEDED_COHORTS = new Set(cohorts.map((c) => c.id));

function visibleTo(item: { ownerUserId: string; visibility: string }, scope: string | null): boolean {
  if (scope === 'mine') return item.ownerUserId === ME;
  if (scope === 'shared') return item.ownerUserId !== ME && item.visibility === 'workspace';
  return item.ownerUserId === ME || item.visibility === 'workspace';
}

function handleReports(req: SampleRequest): unknown {
  const { method, segments: s, query } = req;
  if (s[0] !== 'reports' || s.length > 2) return UNHANDLED;
  if (s.length === 1) {
    if (method === 'GET') {
      const projectId = query.get('projectId') ?? WEBSITE_PROJECT_ID;
      const kind = query.get('kind');
      return listOf(sortNewest(reports.filter((r) => r.projectId === projectId && (!kind || r.kind === kind) && visibleTo(r, query.get('scope')))));
    }
    if (method === 'POST') {
      const input = parse(createPanelReportSchema, req.body);
      const report: PanelReportDto = { id: sampleId('rep'), projectId: input.projectId, kind: input.spec.kind as PanelReportDto['kind'], name: input.name, description: input.description ?? null, spec: { ...input.spec }, ownerUserId: ME, visibility: input.visibility, createdAt: nowIso(), updatedAt: nowIso() };
      reports.push(report);
      return data(report);
    }
    return UNHANDLED;
  }
  const report = reports.find((r) => r.id === s[1]);
  if (!report) return notFound('Report');
  if (method === 'GET') return data(report);
  if (method === 'PATCH') {
    const input = parse(updatePanelReportSchema, req.body);
    if (input.name !== undefined) report.name = input.name;
    if (input.description !== undefined) report.description = input.description;
    if (input.visibility !== undefined) report.visibility = input.visibility;
    if (input.spec) {
      report.spec = { ...input.spec };
      report.kind = input.spec.kind as PanelReportDto['kind'];
    }
    report.updatedAt = nowIso();
    return data(report);
  }
  if (method === 'DELETE') {
    reports.splice(reports.indexOf(report), 1);
    for (const t of tiles.filter((x) => x.reportId === report.id)) tiles.splice(tiles.indexOf(t), 1);
    return undefined;
  }
  return UNHANDLED;
}

function tileDto(t: TileSeed): PanelDashboardTileDto {
  return { id: t.id, dashboardId: t.dashboardId, kind: t.kind, reportId: t.reportId, text: t.text, layout: t.layout, createdAt: isoDaysAgo(30) };
}

function dashboardDetail(dashboard: PanelDashboardDto): PanelDashboardDetailDto {
  const own = tiles.filter((t) => t.dashboardId === dashboard.id).sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  const usedReports = [...new Set(own.map((t) => t.reportId).filter((id): id is string => id !== null))].map((id) => reports.find((r) => r.id === id)).filter((r): r is PanelReportDto => r !== undefined);
  return {
    ...dashboard,
    tiles: own.map((t) => {
      const report = t.reportId ? reports.find((r) => r.id === t.reportId) : undefined;
      return { ...tileDto(t), spec: report ? applyPanelDashboardFilters(report.spec, dashboard.filters) : null };
    }),
    reports: usedReports,
  };
}

function handleDashboards(req: SampleRequest): unknown {
  const { method, segments: s, query } = req;
  if (s[0] !== 'dashboards') return UNHANDLED;
  if (s.length === 1) {
    if (method === 'GET') {
      const projectId = query.get('projectId') ?? WEBSITE_PROJECT_ID;
      return listOf(sortNewest(dashboards.filter((d) => d.projectId === projectId && visibleTo(d, query.get('scope')))));
    }
    if (method === 'POST') {
      const input = parse(createPanelDashboardSchema, req.body);
      const dashboard: PanelDashboardDto = { id: sampleId('dash'), projectId: input.projectId, name: input.name, description: input.description ?? null, ownerUserId: ME, visibility: input.visibility, filters: input.filters ?? null, template: null, createdAt: nowIso(), updatedAt: nowIso() };
      dashboards.push(dashboard);
      return data(dashboard);
    }
    return UNHANDLED;
  }
  if (s[1] === 'templates' && s.length === 2 && method === 'GET') {
    const asked = query.get('locale');
    const locale: PanelTemplateLocale = PANEL_TEMPLATE_LOCALES.find((l) => l === asked) ?? 'en';
    return listOf(templateDtos(locale));
  }
  if (s[1] === 'from-template' && s.length === 2 && method === 'POST') {
    const input = parse(createPanelDashboardFromTemplateSchema, req.body);
    const template = templateSeed(input.template) ?? notFound('Template');
    const locale: PanelTemplateLocale = input.locale ?? 'en';
    const dashboard: PanelDashboardDto = {
      id: sampleId('dash'),
      projectId: input.projectId,
      name: input.name ?? template.name[locale],
      description: template.description[locale],
      ownerUserId: ME,
      visibility: input.visibility,
      filters: { dateRange: { preset: '30d' }, filters: [] },
      template: template.id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    dashboards.push(dashboard);
    template.tiles.forEach((t, i) => {
      if (t.kind === 'text') {
        tiles.push({ id: `${dashboard.id}_t${i + 1}`, dashboardId: dashboard.id, kind: 'text', reportId: null, text: t.text?.[locale] ?? '', layout: t.layout });
        return;
      }
      const kind = t.reportKind ?? 'trends';
      const report: PanelReportDto = { id: sampleId('rep'), projectId: input.projectId, kind, name: t.name?.[locale] ?? kind, description: null, spec: { ...defaultSpec(kind, input.projectId) }, ownerUserId: ME, visibility: input.visibility, createdAt: nowIso(), updatedAt: nowIso() };
      reports.push(report);
      tiles.push({ id: `${dashboard.id}_t${i + 1}`, dashboardId: dashboard.id, kind: 'report', reportId: report.id, text: null, layout: t.layout });
    });
    return data(dashboardDetail(dashboard));
  }
  const dashboard = dashboards.find((d) => d.id === s[1]);
  if (!dashboard) return notFound('Dashboard');
  if (s.length === 2) {
    if (method === 'GET') return data(dashboardDetail(dashboard));
    if (method === 'PATCH') {
      const input = parse(updatePanelDashboardSchema, req.body);
      if (input.name !== undefined) dashboard.name = input.name;
      if (input.description !== undefined) dashboard.description = input.description;
      if (input.visibility !== undefined) dashboard.visibility = input.visibility;
      if (input.filters !== undefined) dashboard.filters = input.filters;
      dashboard.updatedAt = nowIso();
      return data(dashboard);
    }
    if (method === 'DELETE') {
      dashboards.splice(dashboards.indexOf(dashboard), 1);
      for (const t of tiles.filter((x) => x.dashboardId === dashboard.id)) tiles.splice(tiles.indexOf(t), 1);
      return undefined;
    }
    return UNHANDLED;
  }
  if (s[2] === 'tiles' && s.length === 3 && method === 'POST') {
    const input = parse(addPanelDashboardTileSchema, req.body);
    const tile: TileSeed =
      'text' in input
        ? { id: sampleId('tile'), dashboardId: dashboard.id, kind: 'text', reportId: null, text: input.text, layout: input.layout }
        : { id: sampleId('tile'), dashboardId: dashboard.id, kind: 'report', reportId: input.reportId, text: null, layout: input.layout };
    tiles.push(tile);
    dashboard.updatedAt = nowIso();
    return data(tileDto(tile));
  }
  if (s[2] === 'tiles' && s.length === 4) {
    const tile = tiles.find((t) => t.id === s[3] && t.dashboardId === dashboard.id) ?? notFound('Tile');
    if (method === 'PATCH') {
      const input = parse(updatePanelDashboardTileSchema, req.body);
      if (input.layout) tile.layout = input.layout;
      if (input.text !== undefined && tile.kind === 'text') tile.text = input.text;
      dashboard.updatedAt = nowIso();
      return data(tileDto(tile));
    }
    if (method === 'DELETE') {
      tiles.splice(tiles.indexOf(tile), 1);
      return undefined;
    }
  }
  if (s[2] === 'layout' && s.length === 3 && method === 'PUT') {
    const input = parse(setPanelDashboardLayoutSchema, req.body);
    for (const item of input.tiles) {
      const tile = tiles.find((t) => t.id === item.id && t.dashboardId === dashboard.id);
      if (tile) tile.layout = item.layout;
    }
    dashboard.updatedAt = nowIso();
    return data(dashboardDetail(dashboard));
  }
  return UNHANDLED;
}

function handleCohorts(req: SampleRequest): unknown {
  const { method, segments: s, query } = req;
  if (s[0] !== 'cohorts' || s.length > 2) return UNHANDLED;
  if (s.length === 1) {
    if (method === 'GET') {
      const projectId = query.get('projectId') ?? WEBSITE_PROJECT_ID;
      // The four sample cohorts show in every project; ones made here only in theirs.
      return listOf(sortNewest(cohorts.filter((c) => SEEDED_COHORTS.has(c.id) || c.projectId === projectId).map((c) => (SEEDED_COHORTS.has(c.id) ? { ...c, projectId } : c))));
    }
    if (method === 'POST') {
      const input = parse(createPanelCohortSchema, req.body);
      const cohort: PanelCohortDto = { id: sampleId('coh'), projectId: input.projectId, name: input.name, description: input.description ?? null, filter: { ...input.filter }, ownerUserId: ME, createdAt: nowIso(), updatedAt: nowIso() };
      cohorts.push(cohort);
      return data(cohort);
    }
    return UNHANDLED;
  }
  const cohort = cohorts.find((c) => c.id === s[1]);
  if (!cohort) return notFound('Cohort');
  if (method === 'GET') return data(cohort);
  if (method === 'PATCH') {
    const input = parse(updatePanelCohortSchema, req.body);
    if (input.name !== undefined) cohort.name = input.name;
    if (input.description !== undefined) cohort.description = input.description;
    if (input.filter) cohort.filter = { ...input.filter };
    cohort.updatedAt = nowIso();
    return data(cohort);
  }
  if (method === 'DELETE') {
    cohorts.splice(cohorts.indexOf(cohort), 1);
    return undefined;
  }
  return UNHANDLED;
}

// ---------------------------------------------------------------------------
// Group types and groups
// ---------------------------------------------------------------------------

const groupTypes: Array<Omit<PanelGroupTypeDto, 'projectId'>> = [
  { id: 'pngt_sample_company', groupType: 'company', nameSingular: 'Company', namePlural: 'Companies', crmMatchProperty: 'domain', configured: true, collecting: true, createdAt: isoDaysAgo(100), updatedAt: isoDaysAgo(40) },
  { id: 'pngt_sample_workspace', groupType: 'workspace', nameSingular: 'Workspace', namePlural: 'Workspaces', crmMatchProperty: null, configured: true, collecting: true, createdAt: isoDaysAgo(75), updatedAt: isoDaysAgo(75) },
  { id: null, groupType: 'team', nameSingular: 'Team', namePlural: 'Teams', crmMatchProperty: null, configured: false, collecting: true, createdAt: null, updatedAt: null },
];

const TEAMS = ['Sales', 'Support', 'Finance', 'Operations', 'Marketing', 'Product'];

function groupTypesFor(projectId: string): PanelGroupTypeDto[] {
  return groupTypes.map((g) => ({ ...g, projectId }));
}

const deletedGroups = new Set<string>();

function groupsOfType(type: string): PanelGroupDto[] {
  const random = rng(`groups|${type}`);
  const make = (key: string, name: string, properties: Record<string, PanelPropertyScalar>, i: number): PanelGroupDto => ({
    groupType: type,
    groupKey: key,
    name,
    properties: { $name: name, ...properties },
    firstSeen: isoDaysAgo(between(random, 40, 220) , 10),
    lastSeen: i < 6 ? isoMinutesAgo(between(random, 5, 600)) : isoDaysAgo(between(random, 1, 30), between(random, 8, 19)),
  });
  let out: PanelGroupDto[];
  if (type === 'company') {
    out = COMPANIES.map((c, i) => make(c.domain, c.name, { domain: c.domain, industry: c.industry, employees: c.employees, plan: c.plan, country: c.country, mrr: c.mrr }, i));
  } else if (type === 'workspace') {
    out = COMPANIES.map((c, i) => make(`ws_${c.key}01`, `${c.name.split(' ')[0]} workspace`, { plan: c.plan, seats: Math.max(1, Math.round(c.employees / 6)), region: c.country === 'US' ? 'us' : 'eu' }, i));
  } else if (type === 'team') {
    out = TEAMS.map((t, i) => make(`team_${t.toLowerCase()}`, t, { size: between(random, 3, 18) }, i));
  } else {
    out = COMPANIES.slice(0, 8).map((c, i) => make(`${type}_${c.key}`, c.name, { segment: c.industry }, i));
  }
  return out.filter((g) => !deletedGroups.has(`${g.groupType}|${g.groupKey}`)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function groupProfile(projectId: string, type: string, key: string, days: number): PanelGroupProfileDto {
  const group = groupsOfType(type).find((g) => g.groupKey === key) ?? notFound('Group');
  const company = type === 'company' ? COMPANIES.find((c) => c.domain === key) : undefined;
  const people = company ? PEOPLE.filter((p) => p.company === company.name) : PEOPLE.slice(0, 6).filter((_, i) => i % 2 === 0 || type === 'team');
  const random = rng(`group-profile|${type}|${key}`);
  const members: PanelGroupMemberDto[] = people
    .map((p) => ({ distinctId: p.distinctId, lastSeen: p.lastSeen, eventCount: between(random, 12, 480) }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const names = ['$pageview', '$autocapture', ...CUSTOM_EVENT_NAMES];
  const weights = [10, 7, ...CUSTOM_EVENT_NAMES.map(() => 1)];
  const recentEvents: PanelActivityEvent[] = Array.from({ length: 30 }, (_, i) => makeEvent(random, `grp_${key}_${i}`, pick(random, names, weights), Date.now() - (i * between(random, 25, 190) + 4) * 60_000, true))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .map((e, i) => ({ ...e, properties: { ...e.properties, $user_id: members[i % Math.max(1, members.length)]?.distinctId ?? null } }));
  return {
    projectId,
    group,
    hasProfile: true,
    days,
    recentEvents,
    eventCount: members.reduce((n, m) => n + m.eventCount, 0),
    members,
    memberCount: members.length,
    crmCompany: company ? { id: `crm_${company.key}`, name: company.name, domain: company.domain } : null,
  };
}

function handleGroups(req: SampleRequest): unknown {
  const { method, segments: s, query } = req;
  const projectId = query.get('projectId') ?? WEBSITE_PROJECT_ID;
  if (s[0] === 'group-types') {
    if (s.length === 1) {
      if (method === 'GET') return listOf(groupTypesFor(projectId));
      if (method === 'POST') {
        const input = parse(createPanelGroupTypeSchema, req.body);
        const existing = groupTypes.find((g) => g.groupType === input.groupType);
        if (existing?.configured) return fail(409, 'GROUP_TYPE_EXISTS', 'That group type already exists');
        if (!existing && groupTypes.length >= PANEL_MAX_GROUP_TYPES) return fail(409, 'GROUP_TYPE_LIMIT', `A project collects at most ${PANEL_MAX_GROUP_TYPES} group types`);
        const row = existing ?? { id: null, groupType: input.groupType, nameSingular: '', namePlural: '', crmMatchProperty: null, configured: false, collecting: true, createdAt: null, updatedAt: null };
        Object.assign(row, { id: sampleId('pngt'), nameSingular: input.nameSingular, namePlural: input.namePlural, crmMatchProperty: input.crmMatchProperty ?? null, configured: true, collecting: true, createdAt: nowIso(), updatedAt: nowIso() });
        if (!existing) groupTypes.push(row);
        return data({ ...row, projectId: input.projectId });
      }
      return UNHANDLED;
    }
    const row = groupTypes.find((g) => g.id === s[1]) ?? notFound('Group type');
    if (s.length === 2 && method === 'PATCH') {
      const input = parse(updatePanelGroupTypeSchema, req.body);
      if (input.nameSingular !== undefined) row.nameSingular = input.nameSingular;
      if (input.namePlural !== undefined) row.namePlural = input.namePlural;
      if (input.crmMatchProperty !== undefined) row.crmMatchProperty = input.crmMatchProperty;
      row.updatedAt = nowIso();
      return data({ ...row, projectId });
    }
    if (s.length === 2 && method === 'DELETE') {
      groupTypes.splice(groupTypes.indexOf(row), 1);
      return undefined;
    }
    return UNHANDLED;
  }
  if (s[0] !== 'groups') return UNHANDLED;
  if (s.length === 1 && method === 'GET') {
    const type = query.get('type') ?? 'company';
    const search = (query.get('search') ?? '').trim().toLowerCase();
    const items = groupsOfType(type).filter((g) => !search || `${g.groupKey} ${g.name ?? ''}`.toLowerCase().includes(search));
    return paginate(items, query, 50);
  }
  if (s.length === 3) {
    if (method === 'GET') return data(groupProfile(projectId, s[1]!, s[2]!, Number(query.get('days')) || 90));
    if (method === 'DELETE') {
      deletedGroups.add(`${s[1]}|${s[2]}`);
      return undefined;
    }
  }
  return UNHANDLED;
}

// ---------------------------------------------------------------------------

const AREAS: SampleAreaHandler[] = [handleProjects, handleLexicon, handlePeople, handleSessions, handleHeatmaps, handleReports, handleDashboards, handleCohorts, handleGroups];

export const handleObjects: SampleAreaHandler = (req) => {
  const first = req.segments[0];
  if (first === 'usage' && req.segments.length === 1 && req.method === 'GET') return data(usage());
  if (first === 'live' && req.segments.length === 1 && req.method === 'GET') return data(live(req.query.get('projectId') ?? WEBSITE_PROJECT_ID));
  for (const area of AREAS) {
    const result = area(req);
    if (result !== UNHANDLED) return result;
  }
  return UNHANDLED;
};
