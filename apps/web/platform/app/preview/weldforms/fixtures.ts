/**
 * WeldForms preview fixtures: four forms in two folders built from the engine's
 * starter templates, ~40 completed responses over 14 days for the customer
 * feedback form, a few for the others, plus the invitations, integrations,
 * versions, themes, settings, usage and members that go with them.
 *
 * Everything is generated from a seeded PRNG against a `now` anchor, so a run
 * is repeatable and `fixtures.test.ts` can check every piece against the
 * contract in `@weldsuite/app-api-client/schemas/weldforms`.
 * The in-browser API that serves them is `mock-api.ts`.
 */

import {
  choicesOf,
  evaluateSubmission,
  fieldsOf,
  parseDefinition,
  STARTER_TEMPLATES,
  type Answers,
  type FieldBlock,
  type FormDefinition,
} from '@weldsuite/forms-engine';
import { formThemeTokensSchema, type FormThemeTokens } from '@weldsuite/forms-engine/definition';
import type {
  FormAccessEntry,
  FormDetail,
  FormFolder,
  FormIntegration,
  FormInvitation,
  FormResponseDto,
  FormsUsage,
  FormsWorkspaceSettings,
  FormTheme,
  FormUserRef,
  FormVersionDetail,
} from '@weldsuite/app-api-client/schemas/weldforms';

// ---------------------------------------------------------------------------
// Ids and people
// ---------------------------------------------------------------------------

export const PREVIEW_FORM_IDS = {
  feedback: 'frm_preview_feedback',
  event: 'frm_preview_event',
  quiz: 'frm_preview_quiz',
  contact: 'frm_preview_contact',
} as const;

export const PREVIEW_FOLDER_IDS = { customers: 'fld_preview_customers', events: 'fld_preview_events' } as const;
export const PREVIEW_THEME_IDS = { blue: 'thm_preview_blue', midnight: 'thm_preview_midnight', warm: 'thm_preview_warm' } as const;

export interface PreviewMember extends FormUserRef {
  id: string;
  role: string;
  status: string;
  memberType: string;
  picture: string | null;
}

const member = (key: string, name: string): PreviewMember => ({
  id: `mem_preview_${key}`,
  userId: `user_preview_${key}`,
  name,
  email: `${key}@acme.example`,
  imageUrl: null,
  picture: null,
  role: 'MEMBER',
  status: 'active',
  memberType: 'member',
});

export const PREVIEW_MEMBERS: PreviewMember[] = [
  { ...member('sam', 'Sam Rivera'), role: 'OWNER' },
  member('priya', 'Priya Nair'),
  member('tom', 'Tom Becker'),
  member('lena', 'Lena Visser'),
];

const ref = (m: PreviewMember): FormUserRef => ({ userId: m.userId, name: m.name, email: m.email, imageUrl: null });
export const PREVIEW_OWNER = ref(PREVIEW_MEMBERS[0]!);

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

export type Rng = () => number;

/** mulberry32: small, fast and the same on every run. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const int = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const weighted = <T>(rng: Rng, entries: ReadonlyArray<readonly [T, number]>): T => {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1]![0];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Midnight UTC of the day `now` falls on. */
export function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const iso = (d: Date | number) => new Date(d).toISOString();

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export function templateDefinition(id: string): FormDefinition {
  const template = STARTER_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown starter template ${id}`);
  const parsed = parseDefinition(template.definition);
  if (!parsed.ok) throw new Error(`Starter template ${id} is not a valid definition`);
  return parsed.definition;
}

export function templateTitle(id: string): string {
  return STARTER_TEMPLATES.find((t) => t.id === id)?.name.en ?? id;
}

// ---------------------------------------------------------------------------
// Response generation
// ---------------------------------------------------------------------------

const FIRST_NAMES = ['Emma', 'Noah', 'Olivia', 'Liam', 'Sophie', 'Lucas', 'Mila', 'Daan', 'Julia', 'Finn', 'Anna', 'Max', 'Eva', 'Sem', 'Zoe', 'Bram', 'Nina', 'Jesse', 'Isa', 'Ruben'];
const LAST_NAMES = ['de Vries', 'Jansen', 'Bakker', 'Visser', 'Smit', 'Meijer', 'Mulder', 'Bos', 'Vos', 'Peters', 'Hendriks', 'Dekker', 'Brouwer', 'Kok', 'Jacobs'];
const COMPANIES = ['Northwind Logistics', 'Bluebird Studio', 'Harbor & Co', 'Greenleaf Foods', 'Brightside Dental', 'Kite Labs', 'Oakline Interiors'];
const DOMAINS = ['northwind.example', 'bluebird.example', 'harbor.example', 'greenleaf.example', 'gmail.com', 'outlook.com', 'kite.example'];

const WENT_WELL = [
  'Support answered within minutes and actually solved my problem.',
  'The onboarding was clear and the team was friendly.',
  'Everything just works, and invoices are easy to find.',
  'Fast delivery and good communication along the way.',
  'The dashboard saves me an hour every week.',
  'Great value for money compared to what we used before.',
  'Having projects and invoices in one place is a relief.',
  'Our account manager really thinks along with us.',
];
const WENT_WRONG = [
  'It took three days to get a reply to my question.',
  'Pricing changed after I signed up and nobody told me.',
  'The mobile app is slow when I have many files.',
  'I could not find how to export my data.',
  'Delivery was late twice and I had to chase it myself.',
  'The invoice had the wrong VAT number and fixing it took weeks.',
];
const GENERIC_TEXT = ['Looks good to me.', 'Thanks for asking!', 'No further comments.', 'Happy to talk more if useful.'];
const SOURCES = [
  ['link', 5],
  ['email', 4],
  ['qr', 1],
  ['embed', 2],
] as const;
const REFERRERS = ['https://www.google.com/', 'https://app.weldsuite.org/', 'https://www.linkedin.com/', undefined, undefined];
const COUNTRIES = ['NL', 'NL', 'NL', 'BE', 'DE', 'GB', 'FR'];
const BROWSERS: ReadonlyArray<readonly [string, string]> = [
  ['Chrome', 'Windows'],
  ['Chrome', 'macOS'],
  ['Safari', 'macOS'],
  ['Safari', 'iOS'],
  ['Firefox', 'Windows'],
  ['Edge', 'Windows'],
  ['Chrome', 'Android'],
];

interface Person {
  first: string;
  last: string;
  email: string;
  company: string;
}

function person(rng: Rng): Person {
  const first = pick(rng, FIRST_NAMES);
  const last = pick(rng, LAST_NAMES);
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  return { first, last, email: `${clean(first)}.${clean(last)}@${pick(rng, DOMAINS)}`, company: pick(rng, COMPANIES) };
}

function choiceAnswer(field: FieldBlock, rng: Rng, correctBias: number): unknown {
  const choices = choicesOf(field);
  if (choices.length === 0) return undefined;
  const props = field.properties as { multiple?: boolean; allowOther?: boolean };
  const correct = choices.filter((c) => c.correct === true);
  if (correct.length > 0) {
    const chosen = rng() < correctBias ? correct : choices.filter((c) => c.correct !== true);
    return { choiceIds: [pick(rng, chosen).id] };
  }
  if (props.allowOther === true && rng() < 0.12) {
    return { choiceIds: [], other: pick(rng, ['Halal', 'Nut allergy', 'Lactose-free']) };
  }
  if (props.multiple === true) {
    const count = rng() < 0.7 ? 1 : 2;
    const ids = new Set<string>();
    while (ids.size < Math.min(count, choices.length)) ids.add(pick(rng, choices).id);
    return { choiceIds: [...ids] };
  }
  return { choiceIds: [pick(rng, choices).id] };
}

function generateAnswer(field: FieldBlock, rng: Rng, who: Person): unknown {
  switch (field.type) {
    case 'nps':
      return weighted(rng, [
        [int(rng, 0, 6), 22],
        [int(rng, 7, 8), 28],
        [int(rng, 9, 10), 50],
      ]);
    case 'rating':
      return int(rng, 3, field.properties.steps);
    case 'opinion_scale':
      return int(rng, Math.max(field.properties.start, 2), field.properties.end);
    case 'number':
      return weighted(rng, [
        [0, 4],
        [1, 6],
        [2, 3],
        [3, 1],
      ]);
    case 'yes_no':
      return rng() < 0.62;
    case 'legal':
      return true;
    case 'email':
      return who.email;
    case 'phone':
      return `+31 6 ${int(rng, 1000, 9999)} ${int(rng, 1000, 9999)}`;
    case 'website':
      return `https://www.${who.company.toLowerCase().replace(/[^a-z]/g, '')}.example`;
    case 'date':
      return '2026-06-12';
    case 'short_text':
      return who.company;
    case 'long_text': {
      const refName = field.ref;
      if (refName === 'what_went_well') return pick(rng, WENT_WELL);
      if (refName === 'what_went_wrong') return pick(rng, WENT_WRONG);
      return pick(rng, GENERIC_TEXT);
    }
    case 'multiple_choice':
    case 'dropdown':
    case 'picture_choice':
      return choiceAnswer(field, rng, 0.7);
    case 'contact_info':
      return { firstName: who.first, lastName: who.last, email: who.email, phone: `+31 6 ${int(rng, 1000, 9999)} ${int(rng, 1000, 9999)}`, company: who.company };
    default:
      return undefined;
  }
}

/** What the insights need to know about a start that never reached the end. */
export interface FormActivityEvent {
  at: string;
  source: string;
  completed: boolean;
  /** Top-level block ids passed, in order. */
  path: string[];
  /** Where an unfinished start stopped. */
  exitBlockId: string | null;
  responseId: string | null;
}

export interface GeneratedResponses {
  responses: FormResponseDto[];
  activity: FormActivityEvent[];
}

export interface GenerateOptions {
  formId: string;
  versionId: string;
  definition: FormDefinition;
  count: number;
  /** Days back from `now` that responses may land on, 14 = the last two weeks. */
  days: number;
  seed: number;
  now: Date;
}

export function generateResponses(options: GenerateOptions): GeneratedResponses {
  const { formId, versionId, definition, count, days, seed, now } = options;
  const rng = seededRng(seed);
  const fields = fieldsOf(definition);
  const scored = fields.some((f) => choicesOf(f).some((c) => c.score !== undefined));
  const today = startOfDay(now).getTime();

  // Pick a day for each response, busier lately, then sort so numbers run oldest first.
  const times = Array.from({ length: count }, () => {
    const dayBack = Math.min(days - 1, Math.floor(Math.pow(rng(), 1.6) * days));
    const hour = weighted(rng, [
      [int(rng, 8, 11), 4],
      [int(rng, 12, 15), 5],
      [int(rng, 16, 21), 3],
    ]);
    const at = today - dayBack * DAY_MS + hour * HOUR_MS + int(rng, 0, 59) * 60_000;
    return Math.min(at, now.getTime() - 5 * 60_000);
  }).sort((a, b) => a - b);

  const topLevel = definition.blocks.filter((b) => b.type !== 'page_break').map((b) => b.id);
  const responses: FormResponseDto[] = [];
  const activity: FormActivityEvent[] = [];

  times.forEach((submitted, index) => {
    const who = person(rng);
    const raw: Record<string, unknown> = {};
    for (const field of fields) {
      const value = generateAnswer(field, rng, who);
      if (value !== undefined) raw[field.id] = value;
    }
    const result = evaluateSubmission(definition, { answers: raw as Answers });
    const durationMs = int(rng, 35_000, 240_000);
    const source = weighted(rng, SOURCES.map(([s, w]) => [s, w] as const));
    const [browser, os] = pick(rng, BROWSERS);
    const device = os === 'iOS' || os === 'Android' ? 'phone' : 'desktop';
    const referrer = pick(rng, REFERRERS);
    const emailAnswer = Object.values(result.answers).find((v) => typeof v === 'string' && v.includes('@')) as string | undefined;
    const contactEmail = Object.values(result.answers).find(
      (v): v is { email: string } => typeof v === 'object' && v !== null && typeof (v as { email?: unknown }).email === 'string',
    )?.email;
    const respondentEmail = emailAnswer ?? contactEmail ?? null;
    const id = `rsp_${formId.replace(/^frm_/, '')}_${String(index + 1).padStart(3, '0')}`;
    const path = result.path;

    responses.push({
      id,
      formId,
      versionId,
      versionNumber: 1,
      number: index + 1,
      status: 'completed',
      answers: result.answers as Record<string, unknown>,
      hidden: {},
      variables: scored ? { score: result.score } : {},
      score: scored ? result.score : null,
      endingId: result.endingId,
      respondentEmail,
      respondent: null,
      personId: null,
      invitationId: null,
      lastBlockId: path[path.length - 1] ?? null,
      answeredCount: Object.keys(result.answers).length,
      abandoned: false,
      metadata: {
        source,
        device,
        browser,
        os,
        country: pick(rng, COUNTRIES),
        ...(referrer ? { referrer } : {}),
      },
      files: [],
      startedAt: iso(submitted - durationMs),
      submittedAt: iso(submitted),
      durationMs,
      updatedAt: iso(submitted),
    });
    activity.push({ at: iso(submitted - durationMs), source, completed: true, path, exitBlockId: null, responseId: id });
  });

  // Starts that were not finished, for the drop-off chart.
  const abandoned = Math.round(count * 0.35);
  for (let i = 0; i < abandoned; i += 1) {
    const dayBack = Math.min(days - 1, Math.floor(Math.pow(rng(), 1.6) * days));
    const at = Math.min(today - dayBack * DAY_MS + int(rng, 8, 20) * HOUR_MS, now.getTime() - 10 * 60_000);
    const exitIndex = weighted(
      rng,
      topLevel.map((_, i2) => [i2, Math.max(1, topLevel.length - i2)] as const),
    );
    activity.push({
      at: iso(at),
      source: weighted(rng, SOURCES.map(([s, w]) => [s, w] as const)),
      completed: false,
      path: topLevel.slice(0, exitIndex + 1),
      exitBlockId: topLevel[exitIndex] ?? null,
      responseId: null,
    });
  }
  activity.sort((a, b) => a.at.localeCompare(b.at));
  return { responses, activity };
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

const settingsDefaults: FormDetail['settings'] = {
  respondentMode: 'anyone',
  onePerRespondent: false,
  allowEdit: false,
  hideMemberIdentity: false,
  collectPartial: false,
  opensAt: null,
  closesAt: null,
  responseLimit: null,
  closedMessage: null,
  allowedEmbedDomains: [],
  sendReceipt: false,
};

export interface FormRecord {
  detail: FormDetail;
  versions: FormVersionDetail[];
  access: FormAccessEntry[];
  responses: FormResponseDto[];
  activity: FormActivityEvent[];
  invitations: FormInvitation[];
  integrations: FormIntegration[];
  subscription: 'instant' | 'daily' | 'off';
}

export interface WeldFormsFixtures {
  now: string;
  records: FormRecord[];
  folders: FormFolder[];
  themes: FormTheme[];
  settings: FormsWorkspaceSettings;
  usage: FormsUsage;
  members: PreviewMember[];
}

export function publicUrlFor(publicId: string): string {
  return `https://forms.weldsuite.org/f/${publicId}`;
}

interface DetailInit {
  id: string;
  title: string;
  definition: FormDefinition;
  folderId: string | null;
  themeId: string | null;
  status: 'draft' | 'published' | 'closed';
  publicId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  revision: number;
  hasUnpublishedChanges: boolean;
  versionId: string | null;
  responseCount: number;
  lastResponseAt: string | null;
  settings?: Partial<FormDetail['settings']>;
}

/** A form as the API returns it; shared by the fixtures and the mock API's create/duplicate. */
export function buildFormDetail(init: DetailInit): FormDetail {
  const published = init.status !== 'draft' && init.publicId !== null && init.publishedAt !== null;
  const settings = { ...settingsDefaults, ...init.settings };
  return {
    id: init.id,
    title: init.title,
    status: init.status,
    folderId: init.folderId,
    layout: init.definition.presentation.layout,
    publicId: init.publicId,
    publicUrl: init.publicId ? publicUrlFor(init.publicId) : null,
    access: 'workspace',
    respondentMode: settings.respondentMode,
    owner: PREVIEW_OWNER,
    responseCount: init.responseCount,
    lastResponseAt: init.lastResponseAt,
    hasUnpublishedChanges: init.hasUnpublishedChanges,
    publishedAt: init.publishedAt,
    closedAt: init.status === 'closed' ? init.updatedAt : null,
    createdAt: init.createdAt,
    updatedAt: init.updatedAt,
    definition: init.definition,
    settings,
    themeId: init.themeId,
    revision: init.revision,
    publishedVersion:
      published && init.versionId ? { id: init.versionId, number: 1, publishedAt: init.publishedAt as string } : null,
    permissions: {
      edit: true,
      publish: true,
      delete: true,
      send: true,
      readResponses: true,
      exportResponses: true,
      deleteResponses: true,
      manageAccess: true,
    },
    moderation: null,
  };
}

const theme = (id: string, name: string, tokens: unknown, isDefault: boolean, now: Date): FormTheme => ({
  id,
  name,
  tokens: formThemeTokensSchema.parse(tokens),
  isDefault,
  createdAt: iso(now.getTime() - 40 * DAY_MS),
  updatedAt: iso(now.getTime() - 40 * DAY_MS),
});

export function buildThemes(now: Date): FormTheme[] {
  return [
    theme(PREVIEW_THEME_IDS.blue, 'WeldSuite blue', { font: 'inter' }, true, now),
    theme(
      PREVIEW_THEME_IDS.midnight,
      'Midnight',
      {
        font: 'grotesk',
        colors: { background: '#0f172a', question: '#f8fafc', answer: '#38bdf8', button: '#38bdf8', buttonText: '#0f172a' },
        radius: 'large',
      },
      false,
      now,
    ),
    theme(
      PREVIEW_THEME_IDS.warm,
      'Warm paper',
      {
        font: 'serif',
        colors: { background: '#fdf6ec', question: '#3b2f2f', answer: '#c2410c', button: '#c2410c', buttonText: '#ffffff' },
        radius: 'small',
        alignment: 'center',
      },
      false,
      now,
    ),
  ];
}

function publishedVersion(
  formId: string,
  definition: FormDefinition,
  themes: FormTheme[],
  themeId: string | null,
  publishedAt: string,
  responseCount: number,
): FormVersionDetail {
  const tokens: FormThemeTokens | null = themes.find((t) => t.id === themeId)?.tokens ?? null;
  return {
    id: `ver_${formId.replace(/^frm_/, '')}_1`,
    number: 1,
    publishedAt,
    publishedBy: PREVIEW_OWNER,
    responseCount,
    definition,
    theme: tokens,
  };
}

function invitationsFor(formId: string, now: Date, seed: number, completedResponses: FormResponseDto[]): FormInvitation[] {
  const rng = seededRng(seed);
  const statuses = ['completed', 'completed', 'completed', 'completed', 'started', 'opened', 'opened', 'sent', 'sent', 'sent', 'revoked', 'sent'] as const;
  return statuses.map((status, index) => {
    const who = person(rng);
    const sentAt = now.getTime() - (10 - Math.min(index, 8)) * DAY_MS;
    const opened = status === 'opened' || status === 'started' || status === 'completed';
    const started = status === 'started' || status === 'completed';
    const response = status === 'completed' ? (completedResponses[index] ?? null) : null;
    return {
      id: `inv_${formId.replace(/^frm_/, '')}_${String(index + 1).padStart(2, '0')}`,
      formId,
      email: who.email,
      name: `${who.first} ${who.last}`,
      personId: null,
      userId: null,
      locale: 'en' as const,
      status,
      remindersSent: status === 'sent' ? int(rng, 0, 2) : 0,
      responseId: response?.id ?? null,
      sentAt: iso(sentAt),
      openedAt: opened ? iso(sentAt + 2 * HOUR_MS) : null,
      startedAt: started ? iso(sentAt + 3 * HOUR_MS) : null,
      completedAt: status === 'completed' ? iso(sentAt + 3 * HOUR_MS + 90_000) : null,
      lastRemindedAt: null,
      nextReminderAt: status === 'sent' ? iso(now.getTime() + 2 * DAY_MS) : null,
      revokedAt: status === 'revoked' ? iso(sentAt + DAY_MS) : null,
      createdAt: iso(sentAt - 60_000),
    };
  });
}

export function buildFixtures(now: Date = new Date()): WeldFormsFixtures {
  const themes = buildThemes(now);
  const day = (n: number) => iso(now.getTime() - n * DAY_MS);

  const feedbackDef = templateDefinition('customer-feedback');
  const eventDef = templateDefinition('event-registration');
  const quizDef = templateDefinition('knowledge-quiz');
  const contactDef = templateDefinition('contact-form');

  const versionIdOf = (formId: string) => `ver_${formId.replace(/^frm_/, '')}_1`;

  const feedbackGen = generateResponses({ formId: PREVIEW_FORM_IDS.feedback, versionId: versionIdOf(PREVIEW_FORM_IDS.feedback), definition: feedbackDef, count: 40, days: 14, seed: 1101, now });
  const eventGen = generateResponses({ formId: PREVIEW_FORM_IDS.event, versionId: versionIdOf(PREVIEW_FORM_IDS.event), definition: eventDef, count: 12, days: 14, seed: 2202, now });
  const quizGen = generateResponses({ formId: PREVIEW_FORM_IDS.quiz, versionId: versionIdOf(PREVIEW_FORM_IDS.quiz), definition: quizDef, count: 9, days: 10, seed: 3303, now });

  const lastOf = (r: FormResponseDto[]) => r[r.length - 1]?.submittedAt ?? null;

  const feedbackDetail = buildFormDetail({
    id: PREVIEW_FORM_IDS.feedback,
    title: 'Customer feedback (NPS)',
    definition: feedbackDef,
    folderId: PREVIEW_FOLDER_IDS.customers,
    themeId: PREVIEW_THEME_IDS.blue,
    status: 'published',
    publicId: 'k7Qm2xPa',
    createdAt: day(30),
    updatedAt: day(2),
    publishedAt: day(16),
    revision: 6,
    hasUnpublishedChanges: false,
    versionId: versionIdOf(PREVIEW_FORM_IDS.feedback),
    responseCount: feedbackGen.responses.length,
    lastResponseAt: lastOf(feedbackGen.responses),
    settings: { collectPartial: true },
  });
  const eventDetail = buildFormDetail({
    id: PREVIEW_FORM_IDS.event,
    title: 'Customer day registration',
    definition: eventDef,
    folderId: PREVIEW_FOLDER_IDS.events,
    themeId: PREVIEW_THEME_IDS.warm,
    status: 'published',
    publicId: 'Wd9sT3nE',
    createdAt: day(21),
    updatedAt: day(1),
    publishedAt: day(15),
    revision: 9,
    hasUnpublishedChanges: true,
    versionId: versionIdOf(PREVIEW_FORM_IDS.event),
    responseCount: eventGen.responses.length,
    lastResponseAt: lastOf(eventGen.responses),
    settings: { responseLimit: 80, sendReceipt: true },
  });
  const quizDetail = buildFormDetail({
    id: PREVIEW_FORM_IDS.quiz,
    title: 'Solar system quiz',
    definition: quizDef,
    folderId: PREVIEW_FOLDER_IDS.events,
    themeId: PREVIEW_THEME_IDS.midnight,
    status: 'published',
    publicId: 'Qz4vB8rL',
    createdAt: day(12),
    updatedAt: day(4),
    publishedAt: day(10),
    revision: 3,
    hasUnpublishedChanges: false,
    versionId: versionIdOf(PREVIEW_FORM_IDS.quiz),
    responseCount: quizGen.responses.length,
    lastResponseAt: lastOf(quizGen.responses),
  });
  const contactDetail = buildFormDetail({
    id: PREVIEW_FORM_IDS.contact,
    title: 'Website contact form',
    definition: contactDef,
    folderId: null,
    themeId: null,
    status: 'draft',
    publicId: null,
    createdAt: day(3),
    updatedAt: day(0),
    publishedAt: null,
    revision: 2,
    hasUnpublishedChanges: false,
    versionId: null,
    responseCount: 0,
    lastResponseAt: null,
  });

  const makeVersions = (detail: FormDetail, gen: GeneratedResponses) =>
    detail.publishedAt
      ? [publishedVersion(detail.id, detail.definition, themes, detail.themeId, detail.publishedAt, gen.responses.length)]
      : [];

  const crmConfig = (emailFieldId: string, mappings: Array<{ blockId: string; part?: string; crmField: string }>) => ({
    target: 'person',
    emailFieldId,
    createCompany: false,
    mappings: mappings.map((m) => ({ ...m, mode: 'fill_empty' })),
    tags: ['form-lead'],
    logActivity: true,
  });
  const integration = (id: string, formId: string, kind: 'crm' | 'desk' | 'flow', enabled: boolean, config: Record<string, unknown>): FormIntegration => ({
    id,
    formId,
    kind,
    enabled,
    config,
    createdBy: PREVIEW_OWNER,
    lastError: null,
    createdAt: day(14),
    updatedAt: day(14),
  });

  const records: FormRecord[] = [
    {
      detail: feedbackDetail,
      versions: makeVersions(feedbackDetail, feedbackGen),
      access: [
        { user: ref(PREVIEW_MEMBERS[1]!), role: 'editor' },
        { user: ref(PREVIEW_MEMBERS[2]!), role: 'results' },
      ],
      ...feedbackGen,
      invitations: [],
      integrations: [
        integration('fin_preview_crm', PREVIEW_FORM_IDS.feedback, 'crm', true, crmConfig('b_email', [])),
        integration('fin_preview_desk', PREVIEW_FORM_IDS.feedback, 'desk', true, {
          subject: 'Unhappy customer: {{form:title}} #{{response:number}}',
          body: '',
          requesterFieldId: 'b_email',
          priority: 'high',
          tags: ['nps-detractor'],
          attachFiles: true,
        }),
      ],
      subscription: 'daily',
    },
    {
      detail: eventDetail,
      versions: makeVersions(eventDetail, eventGen),
      access: [],
      ...eventGen,
      invitations: invitationsFor(PREVIEW_FORM_IDS.event, now, 4404, eventGen.responses),
      integrations: [
        integration(
          'fin_preview_event_crm',
          PREVIEW_FORM_IDS.event,
          'crm',
          true,
          crmConfig('b_attendee', [
            { blockId: 'b_attendee', part: 'firstName', crmField: 'firstName' },
            { blockId: 'b_attendee', part: 'lastName', crmField: 'lastName' },
            { blockId: 'b_attendee', part: 'email', crmField: 'email' },
          ]),
        ),
      ],
      subscription: 'instant',
    },
    {
      detail: quizDetail,
      versions: makeVersions(quizDetail, quizGen),
      access: [],
      ...quizGen,
      invitations: [],
      integrations: [],
      subscription: 'off',
    },
    {
      detail: contactDetail,
      versions: [],
      access: [],
      responses: [],
      activity: [],
      invitations: [],
      integrations: [],
      subscription: 'instant',
    },
  ];

  const countIn = (folderId: string | null) => records.filter((r) => r.detail.folderId === folderId).length;
  const folder = (id: string, name: string, position: number): FormFolder => ({
    id,
    name,
    position,
    formCount: countIn(id),
    createdAt: day(40),
    updatedAt: day(40),
  });

  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1000);

  return {
    now: now.toISOString(),
    records,
    folders: [folder(PREVIEW_FOLDER_IDS.customers, 'Customers', 0), folder(PREVIEW_FOLDER_IDS.events, 'Events and training', 1)],
    themes,
    settings: {
      defaultThemeId: PREVIEW_THEME_IDS.blue,
      senderName: 'Acme Inc.',
      reminderAfterDays: 3,
      reminderEveryDays: 3,
      reminderMaxCount: 2,
      showBadge: true,
      canHideBadge: true,
    },
    usage: {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      used: records.reduce((sum, r) => sum + r.responses.length, 0),
      limit: 1000,
      plan: 'starter',
    },
    members: PREVIEW_MEMBERS,
  };
}
