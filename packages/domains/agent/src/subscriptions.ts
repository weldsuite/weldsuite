/**
 * Extract entity-event subscriptions from natural-language agent instructions.
 *
 * Uses a lightweight keyword/heuristic map so activation works offline (no LLM)
 * and stays deterministic in tests. Known catalog keys are preferred.
 */

const EVENT_HINTS: Array<{ pattern: RegExp; events: string[] }> = [
  { pattern: /\b(new|created?|incoming)\s+(people|person|contact|contacts)\b/i, events: ['person.created'] },
  { pattern: /\b(people|person|contact|contacts)\s+(created?|added)\b/i, events: ['person.created'] },
  { pattern: /\b(new|created?)\s+(compan(y|ies)|customer|customers)\b/i, events: ['company.created'] },
  { pattern: /\b(new|created?|incoming)\s+(ticket|tickets)\b/i, events: ['ticket.created'] },
  { pattern: /\b(ticket|tickets)\s+(created?|opened|escalated|resolved)\b/i, events: ['ticket.created'] },
  { pattern: /\bticket\.escalated\b/i, events: ['ticket.escalated'] },
  { pattern: /\bticket\.resolved\b/i, events: ['ticket.resolved'] },
  { pattern: /\b(new|created?)\s+(task|tasks)\b/i, events: ['project_task.created'] },
  { pattern: /\b(task|tasks)\s+(created?|completed)\b/i, events: ['project_task.created'] },
  { pattern: /\b(task|tasks)\s+completed\b/i, events: ['project_task.completed'] },
  { pattern: /\b(new|created?)\s+(lead|leads)\b/i, events: ['lead.created'] },
  { pattern: /\b(new|created?)\s+(order|orders)\b/i, events: ['order.created'] },
  { pattern: /\b(email|mail)\s+(received|inbound)\b/i, events: ['email.received'] },
  { pattern: /\binvoice\s+(created|paid|overdue)\b/i, events: ['invoice.created'] },
  { pattern: /\bdeal\s+(created|won|lost)\b/i, events: ['opportunity.created'] },
];

const EXPLICIT_EVENT = /\b([a-z_]+)\.(created|updated|deleted|completed|escalated|resolved|won|lost|paid|overdue|received|placed|shipped|delivered)\b/gi;

/**
 * Derive event subscription keys from instructions.
 * Returns `['manual']` when nothing matches (agent is chat/manual-only).
 */
export function extractEventSubscriptions(instructions: string): string[] {
  const found = new Set<string>();

  for (const hint of EVENT_HINTS) {
    if (hint.pattern.test(instructions)) {
      for (const e of hint.events) found.add(e);
    }
  }

  for (const match of instructions.matchAll(EXPLICIT_EVENT)) {
    found.add(`${match[1]}.${match[2]}`.toLowerCase());
  }

  if (/\bevery\s+(morning|day|hour|week)|schedule|cron\b/i.test(instructions)) {
    found.add('scheduled');
  }

  if (found.size === 0) return ['manual'];
  // Drop pure schedule marker if we also have real entity events
  if (found.size > 1) found.delete('scheduled');
  return [...found];
}
