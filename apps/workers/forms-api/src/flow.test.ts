/**
 * The member side of WeldForms against pglite (tenant + master), in-memory KV
 * and buckets: forms (create, save with revisions, duplicate, delete), publish
 * and versions, restricted forms, the content screen, folders, themes, workspace
 * settings, usage and media. Every route runs through the kit's test harness, so
 * the same tests can be replayed against the Rust backend.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb, conformanceTenantDb } from '@weldsuite/worker-kit/testing';
import { conformanceTarget } from '@weldsuite/worker-kit/testing/conformance';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { FormDetail, FormSummary, FormTheme, FormVersionSummary } from '@weldsuite/app-api-client/schemas/weldforms';
import { formThemeTokensSchema } from '@weldsuite/forms-engine/definition';
import { readPublicCache } from './services/public-cache';
import foldersRoutes from './routes/folders';
import formsRoutes from './routes/forms';
import mediaRoutes from './routes/media';
import settingsRoutes from './routes/settings';
import themesRoutes from './routes/themes';
import { ORG, WS, eventNames, json, memberApp, newWorld, resetForms, seedWorkspace, shareMasterDb, simpleDefinition, surveyDefinition, type World } from './test/support';

// The conformance handles: in conformance mode the TypeScript run of a write
// gets the transaction it is rolled back in (the Rust run writes for real).
const dbs = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(dbs.master),
    getWorkspaceContextForOrg: async () => ({ id: WS, clerkOrgId: ORG, db: conformanceTenantDb(dbs.tenant), suspended: false, licensedApps: null, readOnly: false, readOnlyReason: null }),
  };
});

let db: Database;
let master: MasterDatabase;
let world: World;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  dbs.tenant = db;
  dbs.master = master;
  shareMasterDb(master);
}, 120_000);

beforeEach(async () => {
  world = newWorld();
  await resetForms(db, master);
  await seedWorkspace(master);
});

const FORMS = '/api/forms/forms';
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const forms = (who?: Parameters<typeof memberApp>[4]) => memberApp(FORMS, formsRoutes, world, db, who);

async function createForm(title = 'Feedback', body: Record<string, unknown> = {}, who?: Parameters<typeof memberApp>[4]): Promise<FormDetail> {
  const res = await forms(who).request(FORMS, json({ title, ...body }));
  expect(res.status).toBe(201);
  return data<FormDetail>(res);
}

async function saveDefinition(form: FormDetail, definition: unknown, who?: Parameters<typeof memberApp>[4]): Promise<FormDetail> {
  const res = await forms(who).request(`${FORMS}/${form.id}`, json({ revision: form.revision, definition }, 'PATCH'));
  expect(res.status).toBe(200);
  return data<FormDetail>(res);
}

describe('forms', () => {
  it('creates a blank draft, subscribes the owner and publishes form:created', async () => {
    const form = await createForm('Customer feedback');
    expect(form).toMatchObject({ title: 'Customer feedback', status: 'draft', publicId: null, access: 'workspace', revision: 1, responseCount: 0 });
    expect(form.definition.blocks).toEqual([]);
    expect(form.definition.endings).toHaveLength(1);
    expect(form.owner.userId).toBe('user_owner');
    expect(form.permissions).toMatchObject({ edit: true, publish: true, delete: true, readResponses: true, manageAccess: true });

    const [subscription] = await db.select().from(schema.formSubscriptions).where(eq(schema.formSubscriptions.formId, form.id));
    expect(subscription).toMatchObject({ userId: 'user_owner', mode: 'instant' });
    expect(eventNames(world.sent)).toEqual(['form:created']);
    // In conformance mode the queue holds the TypeScript run's events, with its own new id (the harness compares both runs' events).
    expect(world.sent[0]!.data).toMatchObject({ ...(conformanceTarget() ? {} : { id: form.id }), title: 'Customer feedback', status: 'draft' });
  });

  it('creates from a starter template and in the classic layout', async () => {
    const form = await createForm('From template', { templateId: 'contact-form', layout: 'classic' });
    expect(form.definition.blocks.length).toBeGreaterThan(0);
    expect(form.definition.presentation.layout).toBe('classic');
    expect(form.layout).toBe('classic');

    const unknown = await forms().request(FORMS, json({ title: 'x', templateId: 'no-such-template' }));
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('saves the draft with an optimistic revision and answers 409 REVISION_CONFLICT to a stale save', async () => {
    const form = await createForm();
    const saved = await saveDefinition(form, simpleDefinition());
    expect(saved.revision).toBe(2);
    expect(saved.definition.blocks).toHaveLength(1);

    const stale = await forms().request(`${FORMS}/${form.id}`, json({ revision: 1, title: 'Renamed' }, 'PATCH'));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT', details: { currentRevision: 2 } } });
    const [row] = await db.select().from(schema.forms).where(eq(schema.forms.id, form.id));
    expect(row!.title).toBe('Feedback');
    expect(eventNames(world.sent)).toEqual(['form:created', 'form:updated']);
  });

  it('merges operational settings and refreshes the public cache of a live form', async () => {
    const form = await saveDefinition(await createForm(), simpleDefinition());
    const published = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${form.id}/publish`, json({})));
    const live = published.form;
    const before = await readPublicCache(world.kv, live.publicId!);
    expect(before!.settings.closedMessage).toBeNull();

    const res = await forms().request(`${FORMS}/${live.id}`, json({ revision: live.revision, settings: { closedMessage: 'Back in June', collectPartial: true } }, 'PATCH'));
    const updated = await data<FormDetail>(res);
    expect(updated.settings).toMatchObject({ closedMessage: 'Back in June', collectPartial: true, respondentMode: 'anyone' });
    const after = await readPublicCache(world.kv, live.publicId!);
    expect(after!.settings).toMatchObject({ closedMessage: 'Back in June', collectPartial: true });
  });

  it('lists with search, status and a cursor, and duplicates a form as a new draft', async () => {
    await createForm('Alpha');
    await createForm('Beta');
    const gamma = await createForm('Gamma');
    const list = await forms().request(`${FORMS}?limit=2&sort=title`);
    const body = (await list.json()) as { data: FormSummary[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(body.data.map((f) => f.title)).toEqual(['Alpha', 'Beta']);
    expect(body.pagination).toMatchObject({ totalCount: 3, hasMore: true, cursor: '2' });
    const next = (await (await forms().request(`${FORMS}?limit=2&sort=title&cursor=2`)).json()) as { data: FormSummary[] };
    expect(next.data.map((f) => f.title)).toEqual(['Gamma']);
    const found = (await (await forms().request(`${FORMS}?q=bet`)).json()) as { data: FormSummary[] };
    expect(found.data.map((f) => f.title)).toEqual(['Beta']);

    const copy = await data<FormDetail>(await forms({ userId: 'user_other' }).request(`${FORMS}/${gamma.id}/duplicate`, json({})));
    expect(copy).toMatchObject({ title: 'Gamma (copy)', status: 'draft', publicId: null });
    expect(copy.owner.userId).toBe('user_other');
    expect(copy.id).not.toBe(gamma.id);
  });

  it('deletes the form with its versions, responses, files, links and cache entry', async () => {
    const form = await saveDefinition(await createForm(), simpleDefinition());
    const { form: live } = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${form.id}/publish`, json({})));
    await db.insert(schema.formResponses).values({ id: 'frs_1', formId: live.id, versionId: live.publishedVersion!.id, status: 'completed', number: 1 });
    await world.privateBucket.put('workspaces/org_forms/weldforms/x/file', 'bytes');
    await db.insert(schema.formResponseFiles).values({ id: 'ffl_1', responseId: 'frs_1', formId: live.id, blockId: 'b_name', storageKey: 'workspaces/org_forms/weldforms/x/file', name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 5 });

    const res = await forms().request(`${FORMS}/${live.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await db.select().from(schema.forms).where(eq(schema.forms.id, live.id))).toHaveLength(0);
    expect(await db.select().from(schema.formResponses)).toHaveLength(0);
    expect(await db.select().from(schema.formVersions)).toHaveLength(0);
    expect(await db.select().from(schema.formResponseFiles)).toHaveLength(0);
    expect(await master.select().from(masterSchema.formLinkRegistry)).toHaveLength(0);
    expect(await readPublicCache(world.kv, live.publicId!)).toBeNull();
    expect(await world.privateBucket.get('workspaces/org_forms/weldforms/x/file')).toBeNull();
    expect(eventNames(world.sent)).toContain('form:deleted');
    expect((await forms().request(`${FORMS}/${live.id}`)).status).toBe(404);
  });
});

describe('publishing and versions', () => {
  it('refuses a form without questions (NO_QUESTIONS) and a broken definition (INVALID_DEFINITION)', async () => {
    const empty = await createForm();
    const noQuestions = await forms().request(`${FORMS}/${empty.id}/publish`, json({}));
    expect(noQuestions.status).toBe(422);
    expect(((await noQuestions.json()) as { error: { code: string } }).error.code).toBe('NO_QUESTIONS');

    const definition = simpleDefinition();
    definition.blocks.push({ ...definition.blocks[0]!, id: 'b_other' }); // same ref twice
    const broken = await saveDefinition(empty, definition);
    const res = await forms().request(`${FORMS}/${broken.id}/publish`, json({}));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { issues: Array<{ code: string }> } } };
    expect(body.error.code).toBe('INVALID_DEFINITION');
    expect(body.error.details.issues.map((i) => i.code)).toContain('duplicate_ref');
    expect(await master.select().from(masterSchema.formLinkRegistry)).toHaveLength(0);
  });

  it('publishes: allocates a 10-character public id, registers it, snapshots v1 and fills the cache', async () => {
    const form = await saveDefinition(await createForm('Pulse'), simpleDefinition());
    const res = await forms().request(`${FORMS}/${form.id}/publish`, json({}));
    expect(res.status).toBe(200);
    const { form: live, version } = await data<{ form: FormDetail; version: { id: string; number: number } }>(res);
    expect(live).toMatchObject({ status: 'published', hasUnpublishedChanges: false, moderation: null });
    expect(live.publicId).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(live.publicUrl).toBe(`https://forms.test/f/${live.publicId}`);
    expect(version.number).toBe(1);
    expect(live.publishedVersion).toMatchObject({ id: version.id, number: 1 });

    const [link] = await master.select().from(masterSchema.formLinkRegistry);
    expect(link).toMatchObject({ publicId: live.publicId, workspaceId: WS, clerkOrgId: ORG, formId: live.id, suspendedAt: null, heldAt: null });
    const [row] = await db.select().from(schema.formVersions).where(eq(schema.formVersions.id, version.id));
    expect(row).toMatchObject({ formId: live.id, number: 1, publishedByUserId: 'user_owner' });
    expect(formThemeTokensSchema.safeParse(row!.theme).success).toBe(true);

    const cached = await readPublicCache(world.kv, live.publicId!);
    expect(cached).toMatchObject({ formId: live.id, title: 'Pulse', status: 'published', versionId: version.id, limitReached: false, overQuotaMonth: null });
    expect(cached!.branding).toMatchObject({ workspaceName: 'Acme Staffing', showBadge: true });
    expect(eventNames(world.sent)).toEqual(['form:created', 'form:updated', 'form:published']);
    // In conformance mode the queue holds the TypeScript run's event, with the public id that run drew.
    expect(world.sent.at(-1)!.data).toMatchObject({ id: live.id, ...(conformanceTarget() ? {} : { publicId: live.publicId }), version: 1 });
  });

  it('"Publish changes" makes version 2 on the same link; versions list newest first', async () => {
    const form = await saveDefinition(await createForm(), simpleDefinition());
    const first = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${form.id}/publish`, json({})));
    const edited = await saveDefinition(first.form, { ...simpleDefinition(), welcome: { title: 'Hello' } });
    expect(edited.hasUnpublishedChanges).toBe(true);
    const second = await data<{ form: FormDetail; version: { number: number } }>(await forms().request(`${FORMS}/${form.id}/publish`, json({})));
    expect(second.version.number).toBe(2);
    expect(second.form.publicId).toBe(first.form.publicId);
    expect(await master.select().from(masterSchema.formLinkRegistry)).toHaveLength(1);

    const versions = await data<FormVersionSummary[]>(await forms().request(`${FORMS}/${form.id}/versions`));
    expect(versions.map((v) => v.number)).toEqual([2, 1]);
    const detail = await data<{ definition: { welcome: { title: string } | null } }>(await forms().request(`${FORMS}/${form.id}/versions/${versions[1]!.id}`));
    expect(detail.definition.welcome).toBeNull();
    expect((await forms().request(`${FORMS}/${form.id}/versions/fve_missing`)).status).toBe(404);
  });

  it('closes, reopens and discards unpublished changes', async () => {
    const form = await saveDefinition(await createForm(), simpleDefinition());
    const notLive = await forms().request(`${FORMS}/${form.id}/close`, json({}));
    expect(notLive.status).toBe(409);
    const { form: live } = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${form.id}/publish`, json({})));

    const closed = await data<FormDetail>(await forms().request(`${FORMS}/${live.id}/close`, json({})));
    expect(closed).toMatchObject({ status: 'closed' });
    expect(closed.closedAt).not.toBeNull();
    expect((await readPublicCache(world.kv, live.publicId!))!.status).toBe('closed');

    const reopened = await data<FormDetail>(await forms().request(`${FORMS}/${live.id}/reopen`, json({})));
    expect(reopened).toMatchObject({ status: 'published', closedAt: null });
    expect((await readPublicCache(world.kv, live.publicId!))!.status).toBe('published');

    const edited = await saveDefinition(reopened, { ...simpleDefinition(), welcome: { title: 'Draft only' } });
    expect(edited.definition.welcome).not.toBeNull();
    const discarded = await data<FormDetail>(await forms().request(`${FORMS}/${live.id}/discard`, json({})));
    expect(discarded.definition.welcome).toBeNull();
    expect(discarded.hasUnpublishedChanges).toBe(false);
    expect(eventNames(world.sent)).toEqual(expect.arrayContaining(['form:published', 'form:closed', 'form:updated']));
  });

  it('holds a form whose questions ask for a credential, for staff review', async () => {
    const definition = simpleDefinition();
    definition.blocks.push({ id: 'b_pw', ref: 'pw', type: 'short_text', title: 'Enter your password to continue', required: false, properties: {} });
    const form = await saveDefinition(await createForm('Account check'), definition);
    const { form: live } = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${form.id}/publish`, json({})));
    expect(live.moderation).toMatchObject({ state: 'held' });
    const [link] = await master.select().from(masterSchema.formLinkRegistry);
    expect(link!.heldAt).not.toBeNull();
    expect(link!.heldReason).toContain('credential');

    const brand = simpleDefinition();
    const second = await saveDefinition(await createForm('Microsoft: verify your account'), brand);
    const res = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${second.id}/publish`, json({})));
    expect(res.form.moderation).toMatchObject({ state: 'held' });

    const fine = await saveDefinition(await createForm('Which Google product do you use?'), simpleDefinition());
    const ok = await data<{ form: FormDetail }>(await forms().request(`${FORMS}/${fine.id}/publish`, json({})));
    expect(ok.form.moderation).toBeNull();
  });
});

describe('permissions and restricted forms', () => {
  it('answers 403 without the permission', async () => {
    const reader = { userId: 'user_reader', permissions: ['forms:read'] };
    expect((await forms(reader).request(FORMS, json({ title: 'x' }))).status).toBe(403);
    const form = await createForm();
    expect((await forms(reader).request(`${FORMS}/${form.id}`, json({ revision: 1, title: 'y' }, 'PATCH'))).status).toBe(403);
    expect((await forms(reader).request(`${FORMS}/${form.id}/publish`, json({}))).status).toBe(403);
    expect((await forms(reader).request(`${FORMS}/${form.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await forms(reader).request(`${FORMS}/${form.id}`)).status).toBe(200);
  });

  it('shows form_responses permissions apart from forms permissions', async () => {
    const form = await createForm();
    const viewer = await data<FormDetail>(await forms({ userId: 'user_v', permissions: ['forms:read', 'forms:update'] }).request(`${FORMS}/${form.id}`));
    expect(viewer.permissions).toMatchObject({ edit: true, readResponses: false, exportResponses: false, deleteResponses: false });
    const withAnswers = await data<FormDetail>(await forms({ userId: 'user_v', permissions: ['forms:read', 'form_responses:read'] }).request(`${FORMS}/${form.id}`));
    expect(withAnswers.permissions).toMatchObject({ edit: false, readResponses: true, exportResponses: false });
  });

  it('hides a restricted form from anyone not on its access list (404) but not from the owner or forms:manage', async () => {
    const form = await createForm('Board survey');
    const res = await forms().request(`${FORMS}/${form.id}`, json({ revision: 1, access: 'restricted' }, 'PATCH'));
    expect(res.status).toBe(200);

    const member = { userId: 'user_member', permissions: ['forms:read', 'forms:update', 'form_responses:read'] };
    expect((await forms(member).request(`${FORMS}/${form.id}`)).status).toBe(404);
    expect((await forms(member).request(`${FORMS}/${form.id}`, json({ revision: 2, title: 'x' }, 'PATCH'))).status).toBe(404);
    const hidden = (await (await forms(member).request(FORMS)).json()) as { data: FormSummary[]; pagination: { totalCount: number } };
    expect(hidden.data).toEqual([]);
    expect(hidden.pagination.totalCount).toBe(0);

    const manager = await forms({ userId: 'user_manager', permissions: ['forms:read', 'forms:manage'] }).request(`${FORMS}/${form.id}`);
    expect(manager.status).toBe(200);
    expect((await data<FormDetail>(manager)).permissions.manageAccess).toBe(true);

    const put = await forms().request(`${FORMS}/${form.id}/access`, json({ entries: [{ userId: 'user_member', role: 'results' }, { userId: 'user_owner', role: 'editor' }] }, 'PUT'));
    expect(put.status).toBe(200);
    expect((await data<Array<{ user: { userId: string }; role: string }>>(put)).map((e) => [e.user.userId, e.role])).toEqual([['user_member', 'results']]);

    const results = await forms(member).request(`${FORMS}/${form.id}`);
    expect(results.status).toBe(200);
    expect((await data<FormDetail>(results)).permissions).toMatchObject({ edit: false, delete: false, readResponses: true, manageAccess: false });
    expect((await forms(member).request(`${FORMS}/${form.id}`, json({ revision: 2, title: 'x' }, 'PATCH'))).status).toBe(403);
    expect((await forms(member).request(`${FORMS}/${form.id}/access`)).status).toBe(403);
    const visible = (await (await forms(member).request(FORMS)).json()) as { data: FormSummary[] };
    expect(visible.data.map((f) => f.id)).toEqual([form.id]);

    await forms().request(`${FORMS}/${form.id}/access`, json({ entries: [{ userId: 'user_member', role: 'editor' }] }, 'PUT'));
    const editor = await forms(member).request(`${FORMS}/${form.id}`, json({ revision: 2, title: 'Edited by editor' }, 'PATCH'));
    expect(editor.status).toBe(200);
    // Editors cannot change who sees the form, or delete it.
    expect((await forms(member).request(`${FORMS}/${form.id}`, json({ revision: 3, access: 'workspace' }, 'PATCH'))).status).toBe(403);
    expect((await forms({ userId: 'user_member', permissions: ['forms:read', 'forms:delete'] }).request(`${FORMS}/${form.id}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('keeps the member own subscription per form', async () => {
    const form = await createForm();
    const mine = { userId: 'user_other', permissions: ['forms:read'] };
    expect(await data(await forms(mine).request(`${FORMS}/${form.id}/subscription`))).toEqual({ mode: 'off' });
    const put = await forms(mine).request(`${FORMS}/${form.id}/subscription`, json({ mode: 'daily' }, 'PUT'));
    expect(await data(put)).toEqual({ mode: 'daily' });
    expect(await data(await forms().request(`${FORMS}/${form.id}/subscription`))).toEqual({ mode: 'instant' });
  });
});

describe('folders, themes, settings, usage and media', () => {
  it('manages folders; deleting one moves its forms out', async () => {
    const app = memberApp('/api/forms/folders', foldersRoutes, world, db);
    const created = await data<{ id: string; position: number; name: string }>(await app.request('/api/forms/folders', json({ name: 'HR' })));
    expect(created).toMatchObject({ name: 'HR', position: 0 });
    const second = await data<{ id: string; position: number }>(await app.request('/api/forms/folders', json({ name: 'Sales' })));
    expect(second.position).toBe(1);
    await createForm('In HR', { folderId: created.id });
    const list = await data<Array<{ id: string; formCount: number }>>(await app.request('/api/forms/folders'));
    expect(list.find((f) => f.id === created.id)!.formCount).toBe(1);

    const renamed = await data<{ name: string }>(await app.request(`/api/forms/folders/${created.id}`, json({ name: 'People' }, 'PATCH')));
    expect(renamed.name).toBe('People');
    expect((await app.request(`/api/forms/folders/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    const [orphan] = await db.select().from(schema.forms);
    expect(orphan!.folderId).toBeNull();
    expect((await app.request('/api/forms/folders/ffd_missing', json({ name: 'x' }, 'PATCH'))).status).toBe(404);
    expect(eventNames(world.sent).filter((n) => n.startsWith('form_folder'))).toEqual(['form_folder:created', 'form_folder:created', 'form_folder:updated', 'form_folder:deleted']);
    expect((await createFormWithFolder('ffd_missing')).status).toBe(404);
  });

  it('keeps one default theme and needs forms:manage to change themes', async () => {
    const app = memberApp('/api/forms/themes', themesRoutes, world, db);
    const tokens = formThemeTokensSchema.parse({ colors: { background: '#101010' } });
    const a = await data<FormTheme>(await app.request('/api/forms/themes', json({ name: 'Dark', tokens, isDefault: true })));
    const b = await data<FormTheme>(await app.request('/api/forms/themes', json({ name: 'Light', tokens: formThemeTokensSchema.parse({}), isDefault: true })));
    const list = await data<FormTheme[]>(await app.request('/api/forms/themes'));
    expect(list.filter((t) => t.isDefault).map((t) => t.id)).toEqual([b.id]);
    expect(a.tokens.colors.background).toBe('#101010');

    const member = memberApp('/api/forms/themes', themesRoutes, world, db, { userId: 'user_m', permissions: ['forms:read', 'forms:update'] });
    expect((await member.request('/api/forms/themes', json({ name: 'Nope', tokens }))).status).toBe(403);

    const form = await createForm('Themed');
    expect(form.themeId).toBe(b.id);
    expect((await app.request(`/api/forms/themes/${b.id}`, { method: 'DELETE' })).status).toBe(204);
    const [row] = await db.select().from(schema.forms).where(eq(schema.forms.id, form.id));
    expect(row!.themeId).toBeNull();
    expect(eventNames(world.sent).filter((n) => n.startsWith('form_theme'))).toEqual(['form_theme:created', 'form_theme:created', 'form_theme:deleted']);
  });

  it('reads and updates workspace settings; the badge only switches off on plans that allow it', async () => {
    const app = memberApp('/api/forms', settingsRoutes, world, db);
    expect(await data(await app.request('/api/forms/settings'))).toMatchObject({ defaultThemeId: null, reminderMaxCount: 3, showBadge: true, canHideBadge: false });
    const refused = await app.request('/api/forms/settings', json({ showBadge: false }, 'PATCH'));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('PLAN_REQUIRED');

    const ok = await data(await app.request('/api/forms/settings', json({ senderName: 'Acme Forms', reminderAfterDays: 3 }, 'PATCH')));
    expect(ok).toMatchObject({ senderName: 'Acme Forms', reminderAfterDays: 3, showBadge: true });
    expect(await db.select().from(schema.formSettings)).toHaveLength(1);

    await seedWorkspace(master, 'pro');
    const pro = await data(await app.request('/api/forms/settings', json({ showBadge: false }, 'PATCH')));
    expect(pro).toMatchObject({ showBadge: false, canHideBadge: true });
    expect(await db.select().from(schema.formSettings)).toHaveLength(1);

    const member = memberApp('/api/forms', settingsRoutes, world, db, { userId: 'user_m', permissions: ['forms:read'] });
    expect((await member.request('/api/forms/settings', json({ senderName: 'x' }, 'PATCH'))).status).toBe(403);
  });

  it('counts completed responses this UTC month against the plan quota', async () => {
    const app = memberApp('/api/forms', settingsRoutes, world, db);
    const form = await createForm();
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await db.insert(schema.formResponses).values([
      { id: 'frs_a', formId: form.id, versionId: 'fve_x', status: 'completed', number: 1, submittedAt: now },
      { id: 'frs_b', formId: form.id, versionId: 'fve_x', status: 'completed', number: 2, submittedAt: now },
      { id: 'frs_c', formId: form.id, versionId: 'fve_x', status: 'in_progress' },
      { id: 'frs_d', formId: form.id, versionId: 'fve_x', status: 'completed', number: 3, submittedAt: lastMonth },
    ]);
    const usage = await data<{ used: number; limit: number | null; plan: string | null; periodStart: string }>(await app.request('/api/forms/usage'));
    expect(usage).toMatchObject({ used: 2, limit: 100, plan: 'free' });
    expect(usage.periodStart).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());

    await seedWorkspace(master, 'pro');
    expect(await data(await app.request('/api/forms/usage'))).toMatchObject({ used: 2, limit: 10_000, plan: 'pro' });
  });

  it('stores an image in the public bucket and answers its URL; refuses other types and big files', async () => {
    const app = memberApp('/api/forms/media', mediaRoutes, world, db);
    const upload = (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return app.request('/api/forms/media', { method: 'POST', body: form });
    };
    const ok = await upload(new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' }));
    expect(ok.status).toBe(201);
    const { url, contentType, size } = await data<{ url: string; contentType: string; size: number }>(ok);
    expect(contentType).toBe('image/png');
    expect(size).toBe(3);
    expect(url).toMatch(/^https:\/\/cdn\.test\/workspaces\/org_forms\/weldforms\/media\/[A-Za-z0-9]{16}\.png$/);
    expect(await world.publicBucket.get(url.replace('https://cdn.test/', ''))).not.toBeNull();

    expect((await upload(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))).status).toBe(415);
    expect((await upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))).status).toBe(413);
    const noFile = await app.request('/api/forms/media', { method: 'POST', body: new FormData() });
    expect(noFile.status).toBe(400);
    const denied = memberApp('/api/forms/media', mediaRoutes, world, db, { userId: 'u', permissions: ['forms:read'] });
    expect((await denied.request('/api/forms/media', { method: 'POST', body: new FormData() })).status).toBe(403);
  });
});

async function createFormWithFolder(folderId: string): Promise<Response> {
  return forms().request(FORMS, json({ title: 'Orphan', folderId }));
}
