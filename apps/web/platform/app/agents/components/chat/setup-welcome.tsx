'use client';

import { getTranslations } from '@/lib/i18n';

const STARTERS = ['triageTickets', 'followUpLeads', 'taskDigest'] as const;

/** Example jobs for a new agent, offered above the composer: picking one answers the setup interview's first question. */
export function getSetupStarters(): string[] {
  const t = getTranslations('common').agents.detail.setup.starters;
  return STARTERS.map((id) => t[id].prompt);
}

/**
 * A new agent's first screen: the one question the setup interview starts
 * from. A starter (`getSetupStarters`) or anything typed in the composer is
 * the answer; the agent takes it from there with its own questions.
 */
export function SetupWelcome() {
  const t = getTranslations('common').agents.detail.setup;
  return (
    <div className="flex flex-1 flex-col justify-center py-12 animate-in fade-in duration-300">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t.title}</h2>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">{t.description}</p>
    </div>
  );
}
