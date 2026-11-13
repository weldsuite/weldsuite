/**
 * A one-line reading of a number's route for the list: "Rings Support, then
 * voicemail after 5 min", "Menu: 1 Sales, 2 Support, 0 Voicemail".
 */

import type { DeskPhoneRoute } from '@/hooks/queries/use-desk-phone-settings-queries';
import { DEFAULT_MAX_WAIT_SECONDS } from './phone-route-form';

export interface RouteSummaryStrings {
  notSet: string;
  hangup: string;
  aiAgent: string;
  aiAgentNone: string;
  forward: string;
  voicemail: string;
  agents: string;
  allAgents: string;
  thenVoicemail: string;
  thenHangup: string;
  menu: string;
  choiceNames: { agents: string; voicemail: string; ai_agent: string; forward: string };
  minutes: string;
  seconds: string;
}

export interface RouteSummaryLookups {
  teamName: (id: string) => string | undefined;
  agentName: (id: string) => string | undefined;
}

const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template);

/** 300 -> "5 min", 90 -> "1 min 30 sec", 45 -> "45 sec". */
export function formatWait(totalSeconds: number, s: Pick<RouteSummaryStrings, 'minutes' | 'seconds'>): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(fill(s.minutes, { count: String(minutes) }));
  if (seconds > 0 || minutes === 0) parts.push(fill(s.seconds, { count: String(seconds) }));
  return parts.join(' ');
}

export function summarizeRoute(
  route: DeskPhoneRoute | undefined,
  lookups: RouteSummaryLookups,
  s: RouteSummaryStrings,
): string {
  if (!route) return s.notSet;
  const options = route.options ?? {};
  switch (route.action) {
    case 'hangup':
      return s.hangup;
    case 'ai_agent': {
      const name = route.voiceAgentId ? lookups.agentName(route.voiceAgentId) : undefined;
      return name ? fill(s.aiAgent, { name }) : s.aiAgentNone;
    }
    case 'forward':
      return fill(s.forward, { number: route.forwardToE164 ?? '' });
    case 'voicemail':
      return s.voicemail;
    case 'agents': {
      const team = options.departmentId ? (lookups.teamName(options.departmentId) ?? options.departmentId) : s.allAgents;
      return fill(s.agents, {
        team,
        then: options.whenUnanswered === 'hangup' ? s.thenHangup : s.thenVoicemail,
        wait: formatWait(options.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS, s),
      });
    }
    case 'menu': {
      const choices = (options.menu?.choices ?? []).map(
        (choice) => `${choice.digit} ${choice.label?.trim() || s.choiceNames[choice.action]}`,
      );
      return fill(s.menu, { choices: choices.join(', ') });
    }
  }
}
