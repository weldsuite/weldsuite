/**
 * Search query understanding — turns a natural-language search string into a
 * scoped, structured query the federated search orchestrator can execute.
 *
 * The problem this solves: `services/search.ts` passes the raw query straight
 * into `ILIKE '%…%'` against per-entity columns. That works for "acme" and
 * "INV-2024-0042" but returns nothing at all for "Invoice from Acme Corp" —
 * the string is a sentence and the columns hold fields.
 *
 * Three tiers, cheapest first. Each one only runs if the previous can't
 * resolve the query, so the common Cmd+K keystroke never pays for an LLM:
 *
 *   1. `routeQuery()`    — identifiers, emails and 1–2 word queries skip
 *                          understanding entirely (`kind: 'lexical'`).
 *   2. `parseWithLexicon()` — a bilingual (en/nl) entity-keyword strip.
 *                          "Invoice from Acme Corp" → {invoice, "Acme Corp"}
 *                          in zero ms with no model call. Handles most real
 *                          natural-language searches.
 *   3. `parseWithModel()` — Workers AI `@cf/meta/llama-3.1-8b-instruct-fast`
 *                          via `generateObject`, for anything the lexicon
 *                          can't shape. Cached in KV by normalized query.
 *
 * Security posture: the model NEVER widens access. Its `entityTypes` output is
 * intersected with the caller's already-resolved `permittedTypes` in
 * {@link applyPermittedTypes}, and it emits no SQL — only a type list and
 * search terms that flow into the existing parameterised entity queries.
 *
 * Failure posture: every tier fails open to the raw lexical query. Search must
 * degrade to today's behaviour rather than 500 because the gateway hiccuped.
 */

import {
  assertGatewayConfigured,
  createWeldAI,
  generateObject,
  jsonSchema,
  recommended,
  type AiUsage,
} from '@weldsuite/ai';
import {
  SEARCH_ENTITY_TYPES,
  SEARCH_ENTITY_TYPES_SET,
  type SearchEntityType,
  type SearchUnderstanding,
} from '@weldsuite/app-api-client/schemas/search';
import type { Env } from '../../types';
import { assertAiCredits, chargeAiUsage, type AiMetering } from '../ai/billing';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * How a query's structure was determined — surfaced for telemetry + tests.
 * Sourced from the shared schema so the wire contract and the implementation
 * cannot drift: adding a tier here without adding it there won't compile.
 */
export type QueryUnderstandingSource = SearchUnderstanding['source'];

export interface ParsedSearchQuery {
  /**
   * Entity types the query is asking about. Empty = "no opinion", search every
   * permitted type (today's behaviour).
   */
  entityTypes: SearchEntityType[];
  /**
   * The term the lexical leg should actually match on, with type nouns and
   * function words stripped: "Invoice from Acme Corp" → "Acme Corp".
   * Falls back to the raw query when nothing could be extracted.
   */
  lexicalTerm: string;
  /** Cleaned query used to build the embedding for the semantic leg. */
  semanticQuery: string;
  source: QueryUnderstandingSource;
}

// ---------------------------------------------------------------------------
// Tier 1 — routing
// ---------------------------------------------------------------------------

/**
 * `INV-2024-0042`, `TASK-1042`, `INV2024` — jump-to-record lookups.
 *
 * Two details this shape has to get right. Record numbers carry several
 * hyphen-separated segments, so a single anchored `\d+` misses them. And
 * whitespace is deliberately not allowed: "invoice 2024" is a scoped search
 * ("invoices from 2024") that must reach the parser, while `TASK-1042` is an
 * unambiguous key even though "task" is also a type noun — `searchTasks()`
 * already resolves the `TASK-<n>` form on the lexical path.
 */
const IDENTIFIER_RE = /^#?[a-z]{2,8}-?\d+(?:-\d+)*$/i;
const ALL_DIGITS_RE = /^\d+$/;

/**
 * Decide whether a query is worth structuring at all.
 *
 * Returns `false` for the overwhelming majority of command-palette traffic —
 * short prefixes, record numbers, email addresses — which must stay on the
 * ~40ms lexical path. Structuring those would be pure added latency: there is
 * no sentence to take apart.
 */
export function shouldUnderstand(q: string): boolean {
  const trimmed = q.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('@')) return false;
  if (ALL_DIGITS_RE.test(trimmed)) return false;
  if (IDENTIFIER_RE.test(trimmed)) return false;

  const tokens = tokenize(trimmed);
  if (tokens.length <= 1) return false;

  // Two tokens are worth structuring only when one names an entity type
  // ("acme invoices"); otherwise it's a first+last name and lexical wins.
  if (tokens.length === 2) return tokens.some((t) => TYPE_KEYWORDS.has(t));

  return true;
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tier 2 — bilingual keyword lexicon
// ---------------------------------------------------------------------------

/**
 * Entity-type nouns in both maintained locales. WeldSuite is an en/nl product
 * and Dutch users type "factuur van Acme" as readily as "invoice from Acme",
 * so the lexicon has to cover both or the nl half silently falls through to
 * the (slower, metered) model tier.
 *
 * Keep in sync with SEARCH_ENTITY_TYPES. Singular and plural are both listed
 * rather than stemmed — Dutch plurals (factuur → facturen) don't survive a
 * naive English stemmer.
 */
const TYPE_KEYWORD_MAP: Record<string, SearchEntityType> = {
  // contact
  contact: 'contact', contacts: 'contact',
  contactpersoon: 'contact', contactpersonen: 'contact',
  person: 'contact', people: 'contact', persoon: 'contact', personen: 'contact',
  // customer
  customer: 'customer', customers: 'customer', client: 'customer', clients: 'customer',
  company: 'customer', companies: 'customer',
  klant: 'customer', klanten: 'customer', bedrijf: 'customer', bedrijven: 'customer',
  // lead
  lead: 'lead', leads: 'lead',
  // opportunity
  opportunity: 'opportunity', opportunities: 'opportunity', deal: 'opportunity', deals: 'opportunity',
  kans: 'opportunity', kansen: 'opportunity',
  // ticket
  ticket: 'ticket', tickets: 'ticket',
  // article
  article: 'article', articles: 'article', artikel: 'article', artikelen: 'article',
  // knowledge_page
  wiki: 'knowledge_page', page: 'knowledge_page', pages: 'knowledge_page',
  pagina: 'knowledge_page', pagina_s: 'knowledge_page', kennisbank: 'knowledge_page',
  // product
  product: 'product', products: 'product', producten: 'product',
  // order
  order: 'order', orders: 'order', bestelling: 'order', bestellingen: 'order',
  // invoice
  invoice: 'invoice', invoices: 'invoice', factuur: 'invoice', facturen: 'invoice',
  // bill
  bill: 'bill', bills: 'bill', rekening: 'bill', rekeningen: 'bill',
  inkoopfactuur: 'bill', inkoopfacturen: 'bill',
  // project
  project: 'project', projects: 'project', projecten: 'project',
  // task
  task: 'task', tasks: 'task', taak: 'task', taken: 'task',
  // domain
  domain: 'domain', domains: 'domain', domein: 'domain', domeinen: 'domain',
};

const TYPE_KEYWORDS: ReadonlySet<string> = new Set(Object.keys(TYPE_KEYWORD_MAP));

/**
 * Function words carrying no match value. Stripped only when they sit around
 * an extracted term — never from the middle of a proper noun, since the term
 * is reassembled from the original casing in {@link parseWithLexicon}.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // en
  'a', 'an', 'the', 'from', 'for', 'about', 'with', 'of', 'in', 'on', 'at', 'by',
  'to', 'all', 'any', 'my', 'our', 'show', 'me', 'find', 'search', 'get', 'list',
  'that', 'this', 'is', 'are', 'was', 'were',
  // nl
  'de', 'het', 'een', 'van', 'voor', 'over', 'met', 'in', 'op', 'aan', 'bij',
  'alle', 'mijn', 'onze', 'toon', 'zoek', 'vind', 'laat', 'zien', 'die', 'dat',
  'is', 'zijn', 'was', 'waren',
]);

/**
 * Strip entity-type nouns and function words, keeping whatever is left as the
 * lexical term. Returns `null` when no type keyword was present — that's the
 * signal to escalate to the model tier rather than guess.
 *
 * "Invoice from Acme Corp"  → { entityTypes: ['invoice'], lexicalTerm: 'Acme Corp' }
 * "openstaande facturen"    → null (no type noun matched "openstaande"; 'facturen' does)
 */
export function parseWithLexicon(q: string): ParsedSearchQuery | null {
  const rawTokens = q.trim().split(/\s+/).filter(Boolean);
  const types = new Set<SearchEntityType>();
  const kept: string[] = [];

  for (const raw of rawTokens) {
    const normalized = raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!normalized) continue;

    const mapped = TYPE_KEYWORD_MAP[normalized];
    if (mapped) {
      types.add(mapped);
      continue;
    }
    if (STOPWORDS.has(normalized)) continue;
    kept.push(raw);
  }

  // No entity noun means the lexicon has nothing to contribute — escalating to
  // the model beats emitting a type-less parse that just re-runs today's query.
  if (types.size === 0) return null;

  const lexicalTerm = kept.join(' ').trim();
  return {
    entityTypes: [...types],
    // Everything was a type noun ("show me all invoices") — no term to match
    // on, so fall back to the raw query and let the type scoping do the work.
    lexicalTerm: lexicalTerm || q.trim(),
    semanticQuery: q.trim(),
    source: 'lexicon',
  };
}

// ---------------------------------------------------------------------------
// Tier 3 — Workers AI structured parse
// ---------------------------------------------------------------------------

interface ModelParseOutput {
  entityTypes?: string[];
  searchTerm?: string;
  semanticQuery?: string;
}

/**
 * Plain JSON schema rather than Zod: matches `services/workflow-generation.ts`
 * and `services/mail/ai.ts` — a Zod schema of this shape trips TS2589
 * ("excessively deep") against the AI SDK v7 generics.
 */
const parseSchema = jsonSchema<ModelParseOutput>({
  type: 'object',
  properties: {
    entityTypes: {
      type: 'array',
      items: { type: 'string', enum: [...SEARCH_ENTITY_TYPES] },
    },
    searchTerm: { type: 'string' },
    semanticQuery: { type: 'string' },
  },
  required: ['entityTypes', 'searchTerm', 'semanticQuery'],
  additionalProperties: false,
});

/**
 * Model: the `classify` free tier — `@cf/meta/llama-3.1-8b-instruct-fast`.
 * This is a short extraction on a latency-critical path, not a reasoning task,
 * and the 8B fast model is one of the Workers AI models with JSON-mode
 * support. Cost is fractions of a cent per parse before KV caching.
 */
const PARSE_MODEL = recommended.classify.free;

function buildSystemPrompt(): string {
  return [
    'You extract structured search intent from a search box query in a business platform called WeldSuite.',
    'The platform is bilingual: queries arrive in English or Dutch.',
    '',
    'Output three fields:',
    '- entityTypes: which record types the user is asking for. Use ONLY ids from this list:',
    `  ${SEARCH_ENTITY_TYPES.join(', ')}`,
    '  Return an empty array if the query does not name or imply a specific type.',
    '- searchTerm: the proper noun, name, number or keyword to match records against,',
    '  with the type word and filler words removed. For "Invoice from Acme Corp" this is "Acme Corp".',
    '  If the query is only a type word ("all invoices"), return an empty string.',
    '- semanticQuery: the query restated as a short descriptive phrase, for semantic matching.',
    '',
    'Never invent an entity type that is not in the list. Never return SQL.',
    '',
    'Examples:',
    'Query: "Invoice from Acme Corp"',
    '{"entityTypes":["invoice"],"searchTerm":"Acme Corp","semanticQuery":"invoice from Acme Corp"}',
    'Query: "openstaande facturen van Jansen BV"',
    '{"entityTypes":["invoice"],"searchTerm":"Jansen BV","semanticQuery":"openstaande facturen van Jansen BV"}',
    'Query: "tickets about the broken pump"',
    '{"entityTypes":["ticket"],"searchTerm":"broken pump","semanticQuery":"tickets about the broken pump"}',
    'Query: "who handles the Rotterdam account"',
    '{"entityTypes":["contact","customer"],"searchTerm":"Rotterdam","semanticQuery":"who handles the Rotterdam account"}',
  ].join('\n');
}

/** KV cache — query phrasings repeat heavily across a workspace's users. */
const CACHE_PREFIX = 'search-parse:v1:';
const CACHE_TTL_SECONDS = 60 * 60 * 24;

/**
 * Keys are namespaced per workspace.
 *
 * The cached value is currently a pure function of the query text, so sharing
 * it globally would not leak authorization — but it would store one tenant's
 * typed search strings under a key every other tenant can read, and it would
 * turn into a real leak the moment anything tenant-derived enters
 * {@link ParsedSearchQuery}. Namespacing costs nothing and removes the class.
 */
export function cacheKey(workspaceId: string, q: string): string {
  const normalized = q.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${CACHE_PREFIX}${workspaceId}:${normalized}`;
}

async function readCache(env: Env, workspaceId: string, q: string): Promise<ParsedSearchQuery | null> {
  try {
    const hit = await env.WORKSPACE_CACHE.get(cacheKey(workspaceId, q), 'json');
    return (hit as ParsedSearchQuery | null) ?? null;
  } catch {
    return null;
  }
}

function writeCache(
  env: Env,
  workspaceId: string,
  q: string,
  parsed: ParsedSearchQuery,
): Promise<void> {
  return env.WORKSPACE_CACHE.put(cacheKey(workspaceId, q), JSON.stringify(parsed), {
    expirationTtl: CACHE_TTL_SECONDS,
  }).catch(() => undefined);
}

/**
 * Coerce the model's output into a {@link ParsedSearchQuery}. Unknown entity
 * types are dropped rather than trusted — JSON mode is best-effort on Workers
 * AI ("can't guarantee the model responds according to the requested schema"),
 * so the enum is re-checked here against the runtime allow-list.
 */
export function normalizeModelOutput(raw: ModelParseOutput, q: string): ParsedSearchQuery {
  const entityTypes = (raw.entityTypes ?? []).filter((t): t is SearchEntityType =>
    SEARCH_ENTITY_TYPES_SET.has(t),
  );
  const searchTerm = (raw.searchTerm ?? '').trim();
  return {
    entityTypes: [...new Set(entityTypes)],
    lexicalTerm: searchTerm || q.trim(),
    semanticQuery: (raw.semanticQuery ?? '').trim() || q.trim(),
    source: 'model',
  };
}

async function parseWithModel(
  env: Env,
  q: string,
  resolveMetering: MeteringResolver,
): Promise<ParsedSearchQuery | null> {
  try {
    assertGatewayConfigured(env);
  } catch {
    // No gateway configured — this is a valid deployment state, not an error.
    return null;
  }

  // Resolved here rather than by the caller: this is the only tier that bills,
  // and the lookup hits the master DB. Doing it up front would put a master-DB
  // round trip on every keystroke, including the short prefixes and identifiers
  // the tiering exists to keep fast.
  const metering = await resolveMetering();

  try {
    await assertAiCredits(metering);
  } catch {
    // Empty wallet must not break search; drop to the lexical path silently.
    return null;
  }

  const ai = createWeldAI(env);
  let result: { object: ModelParseOutput; usage: AiUsage };
  try {
    result = await generateObject({
      model: ai.model(PARSE_MODEL),
      schema: parseSchema,
      system: buildSystemPrompt(),
      prompt: `Query: "${q}"`,
    });
  } catch (err) {
    console.warn('[app-api/search] query parse failed:', err instanceof Error ? err.message : err);
    return null;
  }

  await chargeAiUsage(metering, {
    modelId: PARSE_MODEL,
    usage: result.usage,
    op: 'search_query_parse',
  }).catch(() => undefined);

  return normalizeModelOutput(result.object, q);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The no-op parse: today's behaviour, raw query against every permitted type. */
export function passthrough(q: string, source: QueryUnderstandingSource = 'lexical'): ParsedSearchQuery {
  const trimmed = q.trim();
  return { entityTypes: [], lexicalTerm: trimmed, semanticQuery: trimmed, source };
}

/**
 * Lazily resolves the credit-metering context.
 *
 * A thunk rather than a value so the master-DB lookup only happens on the one
 * tier that actually bills — see {@link parseWithModel}.
 */
export type MeteringResolver = () => Promise<AiMetering | null>;

export interface UnderstandQueryOptions {
  /** Namespaces the parse cache. Pass the Clerk org id. */
  workspaceId: string;
  resolveMetering: MeteringResolver;
}

/**
 * Resolve a raw search string into a scoped query. Never throws — every
 * failure path returns a passthrough so the caller can always run a search.
 */
export async function understandQuery(
  env: Env,
  q: string,
  opts: UnderstandQueryOptions,
): Promise<ParsedSearchQuery> {
  if (!shouldUnderstand(q)) return passthrough(q);

  const fromLexicon = parseWithLexicon(q);
  if (fromLexicon) return fromLexicon;

  const cached = await readCache(env, opts.workspaceId, q);
  if (cached) return cached;

  const fromModel = await parseWithModel(env, q, opts.resolveMetering);
  if (!fromModel) return passthrough(q, 'model_failed');

  // Cache write is not awaited into the response path — a slow KV put must not
  // add latency to a keystroke-driven search.
  void writeCache(env, opts.workspaceId, q, fromModel);
  return fromModel;
}

/**
 * Intersect the parsed types with what the caller may actually see.
 *
 * This is the security boundary for the whole feature: understanding can only
 * ever narrow the permitted set, never extend it. An empty intersection means
 * the model guessed a type the user has no permission for — fall back to
 * searching everything permitted rather than returning nothing.
 */
export function applyPermittedTypes(
  parsed: ParsedSearchQuery,
  permittedTypes: SearchEntityType[],
): SearchEntityType[] {
  if (parsed.entityTypes.length === 0) return permittedTypes;
  const permitted = new Set(permittedTypes);
  const scoped = parsed.entityTypes.filter((t) => permitted.has(t));
  return scoped.length > 0 ? scoped : permittedTypes;
}
