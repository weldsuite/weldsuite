/**
 * Which events start an agent by themselves (`eventSubscriptions`).
 *
 * Two sources, in this order of trust:
 *  1. Explicit triggers the user asked for, passed to `save_agent_setup`
 *     ({@link normalizeExplicitTriggers}); an agent saved that way is flagged
 *     ({@link EXPLICIT_TRIGGERS_FLAG}) so Activate keeps them.
 *  2. A deterministic reading of the instructions ({@link extractEventSubscriptions}),
 *     so activation works offline (no LLM) and stays testable.
 *
 * The reading is deliberately conservative. A wrong trigger is expensive: once
 * active, an agent runs (and spends credits) on every matching record. So it
 * works clause by clause and only counts a trigger when the instructions say
 * the agent should react to something that happens ("when a new ticket
 * arrives", "for each new contact", "every morning"). It ignores
 *  - negated clauses ("do not create new tasks", "you have no schedules"),
 *  - things the agent only does when asked ("when the user asks, create a new
 *    person": creating a record is an action, not a trigger).
 * Anything unclear yields `['manual']`: the agent works when asked in chat.
 */

import { isValidSubscription } from '@weldsuite/entity-events';

/** `enabledTools` flag: the agent's subscriptions came from explicit triggers, not from its prompt. */
export const EXPLICIT_TRIGGERS_FLAG = 'agent.explicit_triggers';

export function hasExplicitTriggers(enabledTools: readonly string[] | null | undefined): boolean {
  return (enabledTools ?? []).includes(EXPLICIT_TRIGGERS_FLAG);
}

export function withExplicitTriggersFlag(enabledTools: readonly string[] | null | undefined): string[] {
  return [...new Set([...(enabledTools ?? []), EXPLICIT_TRIGGERS_FLAG])];
}

/** Labels that say how an agent is started without naming a catalog event. */
const MARKERS = new Set(['manual', 'scheduled']);

/**
 * Explicit triggers as stored subscriptions: dotted catalog keys (`ticket:created`
 * is accepted too), plus `manual` / `scheduled`. Unknown keys and the `*`
 * wildcard are reported, not stored. No valid trigger means `['manual']`.
 */
export function normalizeExplicitTriggers(triggers: readonly string[]): {
  subscriptions: string[];
  invalid: string[];
} {
  const subscriptions = new Set<string>();
  const invalid: string[] = [];
  for (const raw of triggers) {
    const key = raw.trim().toLowerCase().replace(':', '.');
    if (MARKERS.has(key) || isValidSubscription(key)) subscriptions.add(key);
    else invalid.push(raw.trim());
  }
  const real = [...subscriptions].filter((key) => key !== 'manual');
  // `manual` next to real triggers adds nothing (the agent can always be asked in chat).
  return { subscriptions: real.length > 0 ? real : ['manual'], invalid };
}

// ---------------------------------------------------------------------------
// Reading the instructions
// ---------------------------------------------------------------------------

/** Words that make a clause something the agent must NOT do, or does not have. */
const NEGATION =
  /\b(?:no|not|never|none|nor|cannot|can't|cant|don't|dont|doesn't|doesnt|do not|does not|won't|will not|shouldn't|should not|mustn't|must not|without|avoid|refrain|unless|except|instead of|rather than)\b/i;

/** Clauses that only apply when someone asks: that is chat, not a trigger. */
const ON_REQUEST = new RegExp(
  [
    String.raw`\b(?:only|just)\s+(?:when|if|on)\s+(?:asked|requested|prompted|told|invoked|the\s+user|a\s+user|users?|someone|they|you\s+are\s+asked)\b`,
    String.raw`\b(?:when(?:ever)?|if|once|as\s+soon\s+as)\s+(?:the\s+|a\s+|any\s+)?(?:user|users|someone|somebody|they|i|we|you)\s+(?:asks?|requests?|tells?|wants?|says?|types?|messages?|mentions?|invokes?)\b`,
    String.raw`\b(?:when|if|once)\s+(?:asked|requested|prompted|told)\b`,
    String.raw`\bon\s+(?:request|demand)\b`,
    String.raw`\bas\s+(?:asked|requested)\b`,
  ].join('|'),
  'i',
);

/** What a clause has to hold for its entity phrase to count as something the agent reacts to. */
const LEAD_IN = /\b(?:when(?:ever)?|each|every|as\s+soon\s+as|upon)\b/i;
/** The agent (or its user) acting: "when you create a new task" is the agent's own work. */
const OWN_ACTION = /\b(?:you|your|i|we|me|my|us|our)\b/i;

const ARRIVES = String.raw`(?:is\s+|are\s+|gets?\s+|was\s+|were\s+|has\s+been\s+|have\s+been\s+|being\s+)?(?:newly\s+)?(?:created|added|opened|submitted|arrives?|arrived|comes?\s+in|come\s+in|received|raised|logged|filed|registered|placed)`;

interface EntityHint {
  /** Regex source for the entity's names. */
  nouns: string;
  /** Subscription for a new record. */
  created: string;
  /** Subscriptions for a status the record reaches: `verb regex source -> event`. */
  transitions?: Array<{ verbs: string; event: string }>;
}

const ENTITIES: EntityHint[] = [
  { nouns: 'people|person|contacts?', created: 'person.created' },
  { nouns: 'compan(?:y|ies)|customers?', created: 'company.created' },
  {
    nouns: 'tickets?',
    created: 'ticket.created',
    transitions: [
      { verbs: 'escalated', event: 'ticket.escalated' },
      { verbs: 'resolved', event: 'ticket.resolved' },
    ],
  },
  {
    nouns: 'tasks?',
    created: 'project_task.created',
    transitions: [{ verbs: 'completed|done|finished', event: 'project_task.completed' }],
  },
  { nouns: 'leads?', created: 'lead.created' },
  { nouns: 'orders?', created: 'order.created' },
  {
    nouns: 'invoices?',
    created: 'invoice.created',
    transitions: [
      { verbs: 'paid', event: 'invoice.paid' },
      { verbs: 'overdue', event: 'invoice.overdue' },
    ],
  },
  {
    nouns: 'deals?|opportunit(?:y|ies)',
    created: 'opportunity.created',
    transitions: [
      { verbs: 'won', event: 'opportunity.won' },
      { verbs: 'lost', event: 'opportunity.lost' },
    ],
  },
];

/** A schedule the agent runs on, never the bare word ("no schedules", "scheduled tasks"). */
const SCHEDULE = new RegExp(
  [
    String.raw`\b(?:every|each)\s+(?:\d+\s+)?(?:morning|day|night|evening|afternoon|hour|minute|week|weekday|weekend|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b`,
    String.raw`\b(?:daily|weekly|hourly|nightly|monthly)\b`,
    String.raw`\bon\s+a\s+(?:daily\s+|weekly\s+|regular\s+|fixed\s+)?schedule\b`,
    String.raw`\bon\s+schedule\b`,
    String.raw`\bcron\b`,
  ].join('|'),
  'i',
);

const EXPLICIT_EVENT =
  /\b([a-z][a-z_]*)\.(created|updated|deleted|completed|escalated|resolved|won|lost|paid|overdue|received|placed|shipped|delivered)\b/gi;

/** Sentences, then clauses: the unit a negation or a request reaches. */
function clausesOf(instructions: string): string[] {
  return instructions
    .replace(/[‘’]/g, "'")
    // A full stop ends a sentence only before a space: `ticket.created` is one word.
    .split(/[;\n\r•]+|(?<=[.!?])\s+/)
    .flatMap((sentence) => sentence.split(/[,:()–—]|\s-\s|\s+(?:but|however|although|though|while|whereas)\s+/i))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** A clause that tells the agent what NOT to do, or that only applies when asked. */
function isExcluded(clause: string): boolean {
  return NEGATION.test(clause) || ON_REQUEST.test(clause);
}

/** Events a clause says the agent reacts to. */
function eventsInClause(clause: string): string[] {
  const found: string[] = [];
  const leadsIn = (index: number) => {
    const before = clause.slice(0, index);
    return LEAD_IN.test(before) && !OWN_ACTION.test(before.slice(before.search(LEAD_IN)));
  };

  for (const entity of ENTITIES) {
    // "a new ticket arrives", "tickets created", "ticket comes in": the clause says it happens.
    const happens = new RegExp(String.raw`\b(?:${entity.nouns})\s+${ARRIVES}\b`, 'i');
    // "new tickets", "incoming contacts": a trigger only after a lead-in ("when", "each", "every") or with a verb after it.
    const adjective = new RegExp(String.raw`\b(new|newly\s+(?:created|added)|incoming|created)\s+(?:${entity.nouns})\b(\s+${ARRIVES}\b)?`, 'i');
    // "for each ticket", "on every contact", "each new lead": each record is an occasion to act.
    // A bare "list every task" is not, so the quantifier needs "for / on / upon / when" or "new".
    const quantified = new RegExp(
      String.raw`\b(?:(?:for|on|upon|when|whenever|as\s+soon\s+as)\s+(?:each|every)\s+(?:new\s+)?|(?:each|every)\s+new\s+)(?:${entity.nouns})\b`,
      'i',
    );

    if (happens.test(clause)) found.push(entity.created);
    const adj = adjective.exec(clause);
    if (adj && (/^incoming$/i.test(adj[1]) || adj[2] || leadsIn(adj.index))) found.push(entity.created);
    const quant = quantified.exec(clause);
    if (quant && !OWN_ACTION.test(clause.slice(0, quant.index))) found.push(entity.created);

    for (const { verbs, event } of entity.transitions ?? []) {
      const reaches = new RegExp(String.raw`\b(?:${entity.nouns})\s+(?:is\s+|are\s+|gets?\s+|was\s+|has\s+been\s+|being\s+)?(?:${verbs})\b`, 'i');
      if (reaches.test(clause)) found.push(event);
    }
  }

  for (const match of clause.matchAll(EXPLICIT_EVENT)) {
    found.push(`${match[1]}.${match[2]}`.toLowerCase());
  }
  return found;
}

/**
 * Derive event subscription keys from instructions.
 * Returns `['manual']` when nothing says the agent should react to something
 * (a chat-only agent).
 */
export function extractEventSubscriptions(instructions: string): string[] {
  const found = new Set<string>();

  for (const clause of clausesOf(instructions)) {
    if (isExcluded(clause)) continue;
    for (const event of eventsInClause(clause)) {
      if (isValidSubscription(event)) found.add(event);
    }
    if (SCHEDULE.test(clause)) found.add('scheduled');
  }

  if (found.size === 0) return ['manual'];
  // Drop pure schedule marker if we also have real entity events
  if (found.size > 1) found.delete('scheduled');
  return [...found];
}
