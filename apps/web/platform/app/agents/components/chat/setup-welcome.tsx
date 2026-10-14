'use client';

import { CalendarClock, Inbox, MessageSquare, Users, type LucideIcon } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';

const STARTERS: Array<{ id: 'triageTickets' | 'followUpLeads' | 'taskDigest' | 'chatHelper'; icon: LucideIcon }> = [
  { id: 'triageTickets', icon: Inbox },
  { id: 'followUpLeads', icon: Users },
  { id: 'taskDigest', icon: CalendarClock },
  { id: 'chatHelper', icon: MessageSquare },
];

/**
 * A new agent's first screen: the one question the setup interview starts
 * from. A starter (or anything typed in the composer) is the answer; the agent
 * takes it from there with its own questions.
 */
export function SetupWelcome({ disabled, onPick }: Readonly<{ disabled?: boolean; onPick: (text: string) => void }>) {
  const t = getTranslations('common').agents.detail.setup;
  return (
    <div className="flex flex-1 flex-col justify-center py-12 animate-in fade-in duration-300">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight">{t.title}</h2>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">{t.description}</p>

      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {STARTERS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(t.starters[id].prompt)}
            className="group flex items-start gap-3 rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-foreground/20 hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-60"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t.starters[id].label}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {t.starters[id].prompt}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
