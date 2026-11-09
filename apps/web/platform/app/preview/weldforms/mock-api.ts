/**
 * An in-browser stand-in for forms-api, for the `/preview/weldforms` scenes.
 *
 * `createWeldFormsMockApi` answers the `/api/forms/*` calls of the platform
 * (and the member directory the pages read) from `fixtures.ts`, in the response
 * shapes of the contract. Writes change the in-memory fixtures, so the builder
 * saves, publishing, folders, invitations and the like behave, and nothing
 * leaves the browser. `installWeldFormsMockFetch` puts it in front of `fetch`.
 *
 * It is a plain function over a request, so `fixtures.test.ts` runs every route
 * through it and parses the answers with the contract's Zod schemas.
 */

import {
  createBlankDefinition,
  createField,
  fieldsOf,
  parseDefinition,
  type FormDefinition,
} from '@weldsuite/forms-engine';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import type {
  FormAiSummary,
  FormDetail,
  FormFolder,
  FormIntegration,
  FormInvitation,
  FormResponseDto,
  FormSummary,
  FormTheme,
  FormVersionSummary,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { buildColumns, buildInsights, buildSummary, filterByRange } from './derive';
import {
  buildFormDetail,
  buildFixtures,
  PREVIEW_FORM_IDS,
  PREVIEW_OWNER,
  publicUrlFor,
  seededRng,
  templateDefinition,
  type FormRecord,
  type WeldFormsFixtures,
} from './fixtures';

export interface MockRequest {
  method: string;
  /** The URL path, e.g. `/api/forms/forms/frm_1/responses`. */
  pathname: string;
  search: URLSearchParams;
  /** The parsed JSON body; undefined for no body or a multipart upload. */
  body?: unknown;
}

export interface MockReply {
  status: number;
  body?: unknown;
  /** A raw text body (the CSV export), sent instead of JSON. */
  text?: string;
  contentType?: string;
}

type Params = string[];
type Handler = (req: MockRequest, p: Params) => MockReply;
type Obj = Record<string, unknown>;

const ok = (data: unknown, status = 200): MockReply => ({ status, body: { data } });
const empty = (): MockReply => ({ status: 204 });
const fail = (status: number, code: string, message: string, details?: unknown): MockReply => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
const notFound = () => fail(404, 'NOT_FOUND', 'Not found');
const asObj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});

function page<T>(items: T[], search: URLSearchParams, defaultLimit = 50): MockReply {
  const limit = Math.min(Number(search.get('limit')) || defaultLimit, 200);
  const offset = Number(search.get('cursor')) || 0;
  const slice = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return {
    status: 200,
    body: { data: slice, pagination: { totalCount: items.length, hasMore, cursor: hasMore ? String(offset + limit) : null } },
  };
}

const SUMMARY_OMIT = ['definition', 'settings', 'themeId', 'revision', 'publishedVersion', 'permissions', 'moderation'] as const;

function toSummary(detail: FormDetail): FormSummary {
  const copy: Obj = { ...detail };
  for (const key of SUMMARY_OMIT) delete copy[key];
  return copy as unknown as FormSummary;
}

/** The plain fields of a form update: everything but the definition. */
function applyFormFields(d: FormDetail, body: Obj): void {
  if (typeof body.title === 'string') d.title = body.title;
  if ('folderId' in body) d.folderId = typeof body.folderId === 'string' ? body.folderId : null;
  if ('themeId' in body) d.themeId = typeof body.themeId === 'string' ? body.themeId : null;
  if (body.access === 'workspace' || body.access === 'restricted') d.access = body.access;
  if (body.settings) {
    d.settings = { ...d.settings, ...asObj(body.settings) } as FormDetail['settings'];
    d.respondentMode = d.settings.respondentMode;
  }
}

/** An answer (or part of one) as CSV text, before quoting. */
function csvValue(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The record an integration makes from a response. */
function actionEntityType(kind: FormIntegration['kind']): string {
  if (kind === 'crm') return 'person';
  if (kind === 'desk') return 'ticket';
  return 'task';
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function createWeldFormsMockApi(fixtures: WeldFormsFixtures = buildFixtures(), clock: () => Date = () => new Date()) {
  const fx = fixtures;
  const now = () => clock().toISOString();
  let counter = 0;
  // Seeded, so a preview run hands out the same public links every time.
  const publicIdRng = seededRng(4404);
  const nextId = (prefix: string) => {
    counter += 1;
    return `${prefix}_preview_${Date.now().toString(36)}${counter}`;
  };

  const record = (id: string): FormRecord | undefined => {
    const found = fx.records.find((r) => r.detail.id === id);
    if (found) {
      // Counts come from what is stored, so deleting a response shows in the list.
      found.detail.responseCount = found.responses.length;
      found.detail.lastResponseAt = found.responses[found.responses.length - 1]?.submittedAt ?? null;
    }
    return found;
  };
  const withForm = (id: string, fn: (r: FormRecord) => MockReply): MockReply => {
    const r = record(id);
    return r ? fn(r) : notFound();
  };
  const folderCount = (folder: FormFolder) => ({ ...folder, formCount: fx.records.filter((r) => r.detail.folderId === folder.id).length });

  const touch = (r: FormRecord) => {
    r.detail.updatedAt = now();
  };

  // ── Forms ──────────────────────────────────────────────────────────────

  const listForms: Handler = (req) => {
    const s = req.search;
    const folderId = s.get('folderId');
    const status = s.get('status');
    const q = s.get('q')?.toLowerCase();
    let items = fx.records.map((r) => record(r.detail.id)!.detail);
    if (folderId) items = items.filter((f) => (folderId === 'none' ? f.folderId === null : f.folderId === folderId));
    if (status) items = items.filter((f) => f.status === status);
    if (q) items = items.filter((f) => f.title.toLowerCase().includes(q));
    const sort = s.get('sort') ?? 'updated';
    items = [...items].sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title);
      if (sort === 'responses') return b.responseCount - a.responseCount;
      if (sort === 'created') return b.createdAt.localeCompare(a.createdAt);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return page(items.map(toSummary), s);
  };

  const createForm: Handler = (req) => {
    const body = asObj(req.body);
    let definition: FormDefinition;
    const given = formDefinitionSchema.safeParse(body.definition);
    if (given.success) definition = given.data;
    else if (typeof body.templateId === 'string') {
      try {
        definition = templateDefinition(body.templateId);
      } catch {
        return fail(422, 'VALIDATION_FAILED', 'Unknown template');
      }
    } else definition = createBlankDefinition();
    if (body.layout === 'classic' || body.layout === 'conversational') {
      definition = { ...definition, presentation: { ...definition.presentation, layout: body.layout } };
    }
    const stamp = now();
    const detail = buildFormDetail({
      id: nextId('frm'),
      title: typeof body.title === 'string' ? body.title : 'Untitled form',
      definition,
      folderId: typeof body.folderId === 'string' ? body.folderId : null,
      themeId: fx.settings.defaultThemeId,
      status: 'draft',
      publicId: null,
      createdAt: stamp,
      updatedAt: stamp,
      publishedAt: null,
      revision: 1,
      hasUnpublishedChanges: false,
      versionId: null,
      responseCount: 0,
      lastResponseAt: null,
    });
    fx.records.unshift({
      detail,
      versions: [],
      access: [],
      responses: [],
      activity: [],
      invitations: [],
      integrations: [],
      subscription: 'instant',
    });
    return ok(detail, 201);
  };

  const updateForm: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const body = asObj(req.body);
      if (typeof body.revision === 'number' && body.revision !== r.detail.revision) {
        return fail(409, 'REVISION_CONFLICT', 'Someone saved this form in the meantime');
      }
      const d = r.detail;
      applyFormFields(d, body);
      if (body.definition !== undefined) {
        const parsed = formDefinitionSchema.safeParse(body.definition);
        if (!parsed.success) return fail(422, 'VALIDATION_FAILED', 'The definition is not valid', parsed.error.issues);
        d.definition = parsed.data;
        d.layout = parsed.data.presentation.layout;
        if (d.status !== 'draft') d.hasUnpublishedChanges = true;
      }
      d.revision += 1;
      touch(r);
      return ok(d);
    });

  const deleteForm: Handler = (_req, [id]) => {
    const index = fx.records.findIndex((r) => r.detail.id === id);
    if (index === -1) return notFound();
    fx.records.splice(index, 1);
    return empty();
  };

  const duplicateForm: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const stamp = now();
      const title = typeof asObj(req.body).title === 'string' ? (asObj(req.body).title as string) : `${r.detail.title} (copy)`;
      const detail = buildFormDetail({
        id: nextId('frm'),
        title,
        definition: structuredClone(r.detail.definition),
        folderId: r.detail.folderId,
        themeId: r.detail.themeId,
        status: 'draft',
        publicId: null,
        createdAt: stamp,
        updatedAt: stamp,
        publishedAt: null,
        revision: 1,
        hasUnpublishedChanges: false,
        versionId: null,
        responseCount: 0,
        lastResponseAt: null,
        settings: r.detail.settings,
      });
      fx.records.unshift({ detail, versions: [], access: [], responses: [], activity: [], invitations: [], integrations: [], subscription: 'instant' });
      return ok(detail, 201);
    });

  const publishForm: Handler = (_req, [id]) =>
    withForm(id!, (r) => {
      const d = r.detail;
      if (fieldsOf(d.definition).length === 0) return fail(422, 'NO_QUESTIONS', 'Add at least one question before publishing');
      const parsed = parseDefinition(d.definition);
      if (!parsed.ok) return fail(422, 'INVALID_DEFINITION', 'The form has problems', parsed.issues);
      const number = r.versions.length + 1;
      const stamp = now();
      const version = {
        id: `ver_${d.id.replace(/^frm_/, '')}_${number}`,
        number,
        publishedAt: stamp,
        publishedBy: PREVIEW_OWNER,
        responseCount: 0,
        definition: structuredClone(d.definition),
        theme: fx.themes.find((t) => t.id === d.themeId)?.tokens ?? null,
      };
      r.versions.push(version);
      const publicId = d.publicId ?? publicIdRng().toString(36).slice(2, 10);
      d.status = 'published';
      d.publicId = publicId;
      d.publicUrl = publicUrlFor(publicId);
      d.publishedAt = d.publishedAt ?? stamp;
      d.closedAt = null;
      d.hasUnpublishedChanges = false;
      d.publishedVersion = { id: version.id, number, publishedAt: stamp };
      touch(r);
      return ok({ form: d, version: { id: version.id, number } });
    });

  const setStatus =
    (status: 'closed' | 'published'): Handler =>
    (_req, [id]) =>
      withForm(id!, (r) => {
        r.detail.status = status;
        r.detail.closedAt = status === 'closed' ? now() : null;
        touch(r);
        return ok(r.detail);
      });

  const discardChanges: Handler = (_req, [id]) =>
    withForm(id!, (r) => {
      const last = r.versions[r.versions.length - 1];
      if (last) r.detail.definition = structuredClone(last.definition);
      r.detail.hasUnpublishedChanges = false;
      r.detail.revision += 1;
      touch(r);
      return ok(r.detail);
    });

  // ── Versions, access, subscription ─────────────────────────────────────

  const versions: Handler = (_req, [id]) =>
    withForm(id!, (r) =>
      ok(
        [...r.versions].reverse().map<FormVersionSummary>(({ id: vid, number, publishedAt, publishedBy, responseCount }) => ({
          id: vid,
          number,
          publishedAt,
          publishedBy,
          responseCount: r.responses.filter((x) => x.versionId === vid).length || responseCount,
        })),
      ),
    );
  const version: Handler = (_req, [id, vid]) => withForm(id!, (r) => {
    const v = r.versions.find((x) => x.id === vid);
    return v ? ok(v) : notFound();
  });
  const access: Handler = (_req, [id]) => withForm(id!, (r) => ok(r.access));
  const setAccess: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const entries = Array.isArray(asObj(req.body).entries) ? (asObj(req.body).entries as Array<{ userId: string; role: 'editor' | 'results' }>) : [];
      r.access = entries.flatMap((e) => {
        const m = fx.members.find((x) => x.userId === e.userId);
        return m ? [{ user: { userId: m.userId, name: m.name, email: m.email, imageUrl: null }, role: e.role }] : [];
      });
      return ok(r.access);
    });
  const subscription: Handler = (_req, [id]) => withForm(id!, (r) => ok({ mode: r.subscription }));
  const setSubscription: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const mode = asObj(req.body).mode;
      if (mode === 'instant' || mode === 'daily' || mode === 'off') r.subscription = mode;
      return ok({ mode: r.subscription });
    });

  // ── Responses ──────────────────────────────────────────────────────────

  const filteredResponses = (r: FormRecord, s: URLSearchParams): FormResponseDto[] => {
    const status = s.get('status') ?? 'completed';
    let items = filterByRange(r.responses, { from: s.get('from') ?? undefined, to: s.get('to') ?? undefined });
    if (status !== 'all') items = items.filter((x) => x.status === status);
    const versionId = s.get('versionId');
    if (versionId) items = items.filter((x) => x.versionId === versionId);
    const q = s.get('q')?.toLowerCase();
    if (q) items = items.filter((x) => `${x.respondentEmail ?? ''} ${JSON.stringify(x.answers)}`.toLowerCase().includes(q));
    const sort = s.get('sort') ?? 'newest';
    return [...items].sort((a, b) => {
      if (sort === 'oldest') return (a.submittedAt ?? '').localeCompare(b.submittedAt ?? '');
      if (sort === 'score_desc') return (b.score ?? -1) - (a.score ?? -1);
      if (sort === 'score_asc') return (a.score ?? Infinity) - (b.score ?? Infinity);
      return (b.submittedAt ?? '').localeCompare(a.submittedAt ?? '');
    });
  };

  const listResponses: Handler = (req, [id]) => withForm(id!, (r) => page(filteredResponses(r, req.search), req.search));

  const exportResponses: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const columns = buildColumns(r.detail.definition, r.responses);
      const rows = filteredResponses(r, req.search).map((resp) =>
        columns
          .map((c) => {
            if (c.blockId) {
              const raw = resp.answers[c.blockId];
              const value = c.part ? asObj(raw)[c.part] : raw;
              return csvCell(csvValue(value));
            }
            if (c.key === 'number') return String(resp.number ?? '');
            if (c.key === 'submittedAt') return resp.submittedAt ?? '';
            if (c.key === 'email') return csvCell(resp.respondentEmail ?? '');
            if (c.key === 'score') return String(resp.score ?? '');
            if (c.key === 'duration') return String(resp.durationMs ?? '');
            return csvCell(resp.metadata.source ?? '');
          })
          .join(','),
      );
      return { status: 200, text: [columns.map((c) => csvCell(c.label)).join(','), ...rows].join('\n'), contentType: 'text/csv' };
    });

  const responseDetail: Handler = (_req, [id, rid]) =>
    withForm(id!, (r) => {
      const resp = r.responses.find((x) => x.id === rid);
      if (!resp) return notFound();
      const actions = r.integrations
        .filter((i) => i.enabled)
        .map((i) => ({
          id: `act_${resp.id}_${i.id}`,
          integrationId: i.id,
          kind: i.kind,
          status: 'done' as const,
          entityType: actionEntityType(i.kind),
          entityId: `${i.kind}_preview_${resp.number ?? 0}`,
          error: null,
          attempts: 1,
          updatedAt: resp.submittedAt ?? resp.startedAt,
        }));
      return ok({ ...resp, actions });
    });

  const deleteResponse: Handler = (_req, [id, rid]) =>
    withForm(id!, (r) => {
      r.responses = r.responses.filter((x) => x.id !== rid);
      return empty();
    });
  const bulkDelete: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const ids = new Set(Array.isArray(asObj(req.body).ids) ? (asObj(req.body).ids as string[]) : []);
      const before = r.responses.length;
      r.responses = r.responses.filter((x) => !ids.has(x.id));
      return ok({ deleted: before - r.responses.length });
    });

  const columns: Handler = (_req, [id]) => withForm(id!, (r) => ok(buildColumns(r.detail.definition, r.responses)));
  const summary: Handler = (req, [id]) =>
    withForm(id!, (r) =>
      ok(
        buildSummary(r.detail.definition, r.responses, {
          from: req.search.get('from') ?? undefined,
          to: req.search.get('to') ?? undefined,
          versionId: req.search.get('versionId') ?? undefined,
        }),
      ),
    );
  const insights: Handler = (req, [id]) =>
    withForm(id!, (r) =>
      ok(buildInsights(r.detail.definition, r.responses, r.activity, { from: req.search.get('from') ?? undefined, to: req.search.get('to') ?? undefined }, clock())),
    );

  // ── Invitations ────────────────────────────────────────────────────────

  const listInvitations: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const status = req.search.get('status');
      const q = req.search.get('q')?.toLowerCase();
      let items = r.invitations;
      if (status) items = items.filter((i) => i.status === status);
      if (q) items = items.filter((i) => `${i.email} ${i.name ?? ''}`.toLowerCase().includes(q));
      return page(items, req.search);
    });
  const invitationStats: Handler = (_req, [id]) =>
    withForm(id!, (r) => {
      const n = (statuses: FormInvitation['status'][]) => r.invitations.filter((i) => statuses.includes(i.status)).length;
      return ok({
        total: r.invitations.length,
        sent: r.invitations.filter((i) => i.sentAt !== null).length,
        opened: r.invitations.filter((i) => i.openedAt !== null).length,
        started: r.invitations.filter((i) => i.startedAt !== null).length,
        completed: n(['completed']),
        revoked: n(['revoked']),
      });
    });
  const invite: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const recipients = asObj(asObj(req.body).recipients);
      const emails = Array.isArray(recipients.emails) ? (recipients.emails as Array<{ email: string; name?: string }>) : [];
      const skipped: Array<{ email: string; reason: 'duplicate' | 'invalid' | 'no_email' | 'already_responded' }> = [];
      let created = 0;
      for (const entry of emails) {
        if (r.invitations.some((i) => i.email.toLowerCase() === entry.email.toLowerCase())) {
          skipped.push({ email: entry.email, reason: 'duplicate' });
          continue;
        }
        const stamp = now();
        r.invitations.unshift({
          id: nextId('inv'),
          formId: r.detail.id,
          email: entry.email,
          name: entry.name ?? null,
          personId: null,
          userId: null,
          locale: 'en',
          status: 'sent',
          remindersSent: 0,
          responseId: null,
          sentAt: stamp,
          openedAt: null,
          startedAt: null,
          completedAt: null,
          lastRemindedAt: null,
          nextReminderAt: null,
          revokedAt: null,
          createdAt: stamp,
        });
        created += 1;
      }
      return ok({ created, skipped }, 201);
    });
  const remind: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const ids = asObj(req.body).invitationIds;
      const targets = r.invitations.filter((i) => ['sent', 'opened', 'started'].includes(i.status) && (!Array.isArray(ids) || ids.includes(i.id)));
      for (const i of targets) {
        i.remindersSent += 1;
        i.lastRemindedAt = now();
      }
      return ok({ reminded: targets.length, skipped: 0 });
    });
  const revoke: Handler = (_req, [id, iid]) =>
    withForm(id!, (r) => {
      const inv = r.invitations.find((i) => i.id === iid);
      if (!inv) return notFound();
      inv.status = 'revoked';
      inv.revokedAt = now();
      return ok(inv);
    });

  // ── Integrations ───────────────────────────────────────────────────────

  const integrations: Handler = (_req, [id]) => withForm(id!, (r) => ok(r.integrations));
  const createIntegration: Handler = (req, [id]) =>
    withForm(id!, (r) => {
      const body = asObj(req.body);
      const kind = body.kind;
      if (kind !== 'crm' && kind !== 'desk' && kind !== 'flow') return fail(422, 'VALIDATION_FAILED', 'Unknown integration');
      const stamp = now();
      const created: FormIntegration = {
        id: nextId('fin'),
        formId: r.detail.id,
        kind,
        enabled: body.enabled !== false,
        config: asObj(body.config),
        createdBy: PREVIEW_OWNER,
        lastError: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      r.integrations.push(created);
      return ok(created, 201);
    });
  const updateIntegration: Handler = (req, [id, iid]) =>
    withForm(id!, (r) => {
      const found = r.integrations.find((i) => i.id === iid);
      if (!found) return notFound();
      const body = asObj(req.body);
      if (typeof body.enabled === 'boolean') found.enabled = body.enabled;
      if (body.config) found.config = asObj(body.config);
      found.updatedAt = now();
      return ok(found);
    });
  const deleteIntegration: Handler = (_req, [id, iid]) =>
    withForm(id!, (r) => {
      r.integrations = r.integrations.filter((i) => i.id !== iid);
      return empty();
    });
  const testIntegration: Handler = () => ok({ ok: true, message: 'Test run: the latest response would be sent.' });

  // ── AI ─────────────────────────────────────────────────────────────────

  const aiSummaryFor = (r: FormRecord, blockId: string | null): FormAiSummary => {
    const hasText = r.responses.length > 0 && r.detail.id === PREVIEW_FORM_IDS.feedback;
    return {
      blockId,
      summary: hasText
        ? {
            overview:
              'Most customers are happy and mention fast support and a clear dashboard. The unhappy ones point to slow replies and unannounced pricing changes.',
            themes: [
              { label: 'Fast, helpful support', count: 14, quotes: ['Support answered within minutes and actually solved my problem.'] },
              { label: 'Clear dashboard and invoices', count: 9, quotes: ['The dashboard saves me an hour every week.'] },
              { label: 'Slow replies', count: 5, quotes: ['It took three days to get a reply to my question.'] },
            ],
            sentiment: { positive: 26, neutral: 8, negative: 6 },
          }
        : null,
      stale: false,
      responseCount: r.responses.length,
      createdAt: hasText ? now() : null,
    };
  };

  // ── Folders, themes, settings ──────────────────────────────────────────

  const folders: Handler = () => ok([...fx.folders].sort((a, b) => a.position - b.position).map(folderCount));
  const createFolder: Handler = (req) => {
    const stamp = now();
    const folder: FormFolder = {
      id: nextId('fld'),
      name: typeof asObj(req.body).name === 'string' ? (asObj(req.body).name as string) : 'New folder',
      position: fx.folders.length,
      formCount: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    fx.folders.push(folder);
    return ok(folder, 201);
  };
  const updateFolder: Handler = (req, [fid]) => {
    const folder = fx.folders.find((f) => f.id === fid);
    if (!folder) return notFound();
    const body = asObj(req.body);
    if (typeof body.name === 'string') folder.name = body.name;
    if (typeof body.position === 'number') folder.position = body.position;
    folder.updatedAt = now();
    return ok(folderCount(folder));
  };
  const deleteFolder: Handler = (_req, [fid]) => {
    fx.folders = fx.folders.filter((f) => f.id !== fid);
    for (const r of fx.records) if (r.detail.folderId === fid) r.detail.folderId = null;
    return empty();
  };

  const themes: Handler = () => ok(fx.themes);
  const createTheme: Handler = (req) => {
    const body = asObj(req.body);
    const stamp = now();
    const created: FormTheme = {
      id: nextId('thm'),
      name: typeof body.name === 'string' ? body.name : 'New theme',
      tokens: body.tokens as FormTheme['tokens'],
      isDefault: body.isDefault === true,
      createdAt: stamp,
      updatedAt: stamp,
    };
    fx.themes.push(created);
    return ok(created, 201);
  };
  const updateTheme: Handler = (req, [tid]) => {
    const found = fx.themes.find((t) => t.id === tid);
    if (!found) return notFound();
    const body = asObj(req.body);
    if (typeof body.name === 'string') found.name = body.name;
    if (body.tokens) found.tokens = body.tokens as FormTheme['tokens'];
    if (typeof body.isDefault === 'boolean') found.isDefault = body.isDefault;
    found.updatedAt = now();
    return ok(found);
  };
  const deleteTheme: Handler = (_req, [tid]) => {
    fx.themes = fx.themes.filter((t) => t.id !== tid);
    return empty();
  };

  const settings: Handler = () => ok(fx.settings);
  const updateSettings: Handler = (req) => {
    // Whether the badge can be hidden comes from the plan, never from the request.
    const rest = { ...asObj(req.body) };
    delete rest.canHideBadge;
    fx.settings = { ...fx.settings, ...rest };
    return ok(fx.settings);
  };

  // ── Routes ─────────────────────────────────────────────────────────────

  const F = '/api/forms/forms';
  const routes: Array<[string, RegExp, Handler]> = [
    ['GET', /^\/api\/team-members$/, (req) => page(fx.members, req.search, 100)],

    ['GET', new RegExp(`^${F}$`), listForms],
    ['POST', new RegExp(`^${F}$`), createForm],
    ['GET', new RegExp(`^${F}/([^/]+)$`), (_r, [id]) => withForm(id!, (r) => ok(r.detail))],
    ['PATCH', new RegExp(`^${F}/([^/]+)$`), updateForm],
    ['DELETE', new RegExp(`^${F}/([^/]+)$`), deleteForm],
    ['POST', new RegExp(`^${F}/([^/]+)/duplicate$`), duplicateForm],
    ['POST', new RegExp(`^${F}/([^/]+)/publish$`), publishForm],
    ['POST', new RegExp(`^${F}/([^/]+)/close$`), setStatus('closed')],
    ['POST', new RegExp(`^${F}/([^/]+)/reopen$`), setStatus('published')],
    ['POST', new RegExp(`^${F}/([^/]+)/discard$`), discardChanges],
    ['GET', new RegExp(`^${F}/([^/]+)/versions$`), versions],
    ['GET', new RegExp(`^${F}/([^/]+)/versions/([^/]+)$`), version],
    ['GET', new RegExp(`^${F}/([^/]+)/access$`), access],
    ['PUT', new RegExp(`^${F}/([^/]+)/access$`), setAccess],
    ['GET', new RegExp(`^${F}/([^/]+)/subscription$`), subscription],
    ['PUT', new RegExp(`^${F}/([^/]+)/subscription$`), setSubscription],

    ['GET', new RegExp(`^${F}/([^/]+)/responses$`), listResponses],
    ['GET', new RegExp(`^${F}/([^/]+)/responses/export$`), exportResponses],
    ['POST', new RegExp(`^${F}/([^/]+)/responses/bulk-delete$`), bulkDelete],
    ['GET', new RegExp(`^${F}/([^/]+)/responses/([^/]+)$`), responseDetail],
    ['DELETE', new RegExp(`^${F}/([^/]+)/responses/([^/]+)$`), deleteResponse],
    ['POST', new RegExp(`^${F}/([^/]+)/responses/([^/]+)/actions/([^/]+)/retry$`), () => ok({ queued: true })],
    ['GET', new RegExp(`^${F}/([^/]+)/columns$`), columns],
    ['GET', new RegExp(`^${F}/([^/]+)/summary$`), summary],
    ['GET', new RegExp(`^${F}/([^/]+)/insights$`), insights],

    ['GET', new RegExp(`^${F}/([^/]+)/invitations$`), listInvitations],
    ['POST', new RegExp(`^${F}/([^/]+)/invitations$`), invite],
    ['GET', new RegExp(`^${F}/([^/]+)/invitations/stats$`), invitationStats],
    ['POST', new RegExp(`^${F}/([^/]+)/invitations/remind$`), remind],
    ['POST', new RegExp(`^${F}/([^/]+)/invitations/([^/]+)/revoke$`), revoke],

    ['GET', new RegExp(`^${F}/([^/]+)/integrations$`), integrations],
    ['POST', new RegExp(`^${F}/([^/]+)/integrations$`), createIntegration],
    ['PATCH', new RegExp(`^${F}/([^/]+)/integrations/([^/]+)$`), updateIntegration],
    ['DELETE', new RegExp(`^${F}/([^/]+)/integrations/([^/]+)$`), deleteIntegration],
    ['POST', new RegExp(`^${F}/([^/]+)/integrations/([^/]+)/test$`), testIntegration],

    ['GET', new RegExp(`^${F}/([^/]+)/ai/summary$`), (req, [id]) => withForm(id!, (r) => ok(aiSummaryFor(r, req.search.get('blockId'))))],
    [
      'POST',
      new RegExp(`^${F}/([^/]+)/ai/summary$`),
      (req, [id]) => withForm(id!, (r) => ok(aiSummaryFor(r, typeof asObj(req.body).blockId === 'string' ? (asObj(req.body).blockId as string) : null))),
    ],
    ['POST', /^\/api\/forms\/ai\/generate$/, () => ok({ title: 'Customer feedback', definition: templateDefinition('customer-feedback') })],
    [
      'POST',
      /^\/api\/forms\/ai\/suggest-blocks$/,
      () =>
        ok({
          blocks: [
            createField('short_text', { title: 'What is your company name?' }),
            createField('rating', { title: 'How would you rate our support?' }),
          ],
        }),
    ],

    ['GET', /^\/api\/forms\/folders$/, folders],
    ['POST', /^\/api\/forms\/folders$/, createFolder],
    ['PATCH', /^\/api\/forms\/folders\/([^/]+)$/, updateFolder],
    ['DELETE', /^\/api\/forms\/folders\/([^/]+)$/, deleteFolder],
    ['GET', /^\/api\/forms\/themes$/, themes],
    ['POST', /^\/api\/forms\/themes$/, createTheme],
    ['PATCH', /^\/api\/forms\/themes\/([^/]+)$/, updateTheme],
    ['DELETE', /^\/api\/forms\/themes\/([^/]+)$/, deleteTheme],
    ['GET', /^\/api\/forms\/settings$/, settings],
    ['PATCH', /^\/api\/forms\/settings$/, updateSettings],
    ['GET', /^\/api\/forms\/usage$/, () => ok(fx.usage)],
    ['POST', /^\/api\/forms\/media$/, () => ok({ url: 'https://images.example.com/weldforms/preview-image.png', contentType: 'image/png', size: 48_213 })],
    ['POST', /^\/api\/forms\/erase$/, () => ok({ responsesDeleted: 0, formsAffected: 0 })],
  ];

  /** Whether this mock answers the path at all (everything else goes to the network). */
  function handles(pathname: string): boolean {
    return pathname.startsWith('/api/forms/') || pathname === '/api/team-members';
  }

  function handle(req: MockRequest): MockReply {
    for (const [method, pattern, handler] of routes) {
      if (method !== req.method) continue;
      const match = pattern.exec(req.pathname);
      if (match) return handler(req, match.slice(1));
    }
    return fail(404, 'not_mocked', 'No preview fixture for this request');
  }

  return { handles, handle, fixtures: fx };
}

export type WeldFormsMockApi = ReturnType<typeof createWeldFormsMockApi>;

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

let shared: WeldFormsMockApi | null = null;
let restore: (() => void) | null = null;

/** The one in-memory store of the page, so edits survive moving between the preview routes. */
export function getWeldFormsMockApi(): WeldFormsMockApi {
  shared ??= createWeldFormsMockApi();
  return shared;
}

/**
 * Answers the module's API calls in the browser. Idempotent; the returned
 * function removes it again (the shell calls it on unmount so other preview
 * scenes see the real `fetch`).
 */
export function installWeldFormsMockFetch(api: WeldFormsMockApi = getWeldFormsMockApi()): () => void {
  if (restore) return restore;
  const original = window.fetch;
  const patched: typeof window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const href = request?.url ?? (input instanceof URL ? input.href : String(input));
    const url = new URL(href, window.location.href);
    if (!api.handles(url.pathname)) return original.call(window, input, init);

    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    let body: unknown;
    const raw = init?.body ?? undefined;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }
    const reply = api.handle({ method, pathname: url.pathname, search: url.searchParams, body });
    if (reply.status === 204) return new Response(null, { status: 204 });
    if (reply.text !== undefined) return new Response(reply.text, { status: reply.status, headers: { 'content-type': reply.contentType ?? 'text/plain' } });
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  window.fetch = patched;
  const uninstall = () => {
    if (window.fetch === patched) window.fetch = original;
    restore = null;
  };
  restore = uninstall;
  return uninstall;
}
