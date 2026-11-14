/**
 * Pure helpers of the capacity page: bands, date ranges, grouping people by
 * skill and reading skill lists typed as text. The load itself is computed
 * by flow-api (`@weldsuite/flow-domain/capacity`); this only shapes it.
 */

import { localeConfig, type Language } from '@weldsuite/i18n/locales';
import type { CapacityBand, MemberCapacity } from '@weldsuite/app-api-client/domains/flow-portfolio';

/** The `Intl` locale of the user's language ("nl" is "nl-NL"). */
export function intlLocaleOf(language: Language): string {
  return localeConfig[language]?.intlLocale ?? 'en-US';
}

/** Cell colours in rising darkness, so the bands differ in lightness and not only in hue. */
export const BAND_CLASS: Record<CapacityBand, string> = {
  none: 'bg-muted/40 text-muted-foreground',
  under: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
  ok: 'bg-blue-200 text-blue-950 dark:bg-blue-900 dark:text-blue-100',
  full: 'bg-blue-400 text-blue-950 dark:bg-blue-600 dark:text-white',
  over: 'bg-orange-400 text-orange-950 dark:bg-orange-600 dark:text-white',
  critical: 'bg-orange-700 text-white dark:bg-orange-800',
};

export const BANDS: readonly CapacityBand[] = ['none', 'under', 'ok', 'full', 'over', 'critical'];

/** The band of a load, as flow-domain's `capacityBand` computes it. */
export function bandOf(hours: number, percent: number | null): CapacityBand {
  if (hours <= 0) return 'none';
  if (percent === null) return 'critical';
  if (percent < 50) return 'under';
  if (percent < 80) return 'ok';
  if (percent <= 100) return 'full';
  if (percent <= 120) return 'over';
  return 'critical';
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of today (UTC). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The range of `weeks` weeks starting on `from` (the API widens it to whole ISO weeks). */
export function rangeOf(from: string, weeks: number): { from: string; to: string } {
  return { from, to: addDays(from, weeks * 7 - 1) };
}

/** "2 Nov" in the user's language. */
export function formatDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

/** Skills typed as text: comma separated, trimmed, each once. */
export function splitSkills(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(',')) {
    const skill = part.trim();
    if (skill && !seen.has(skill.toLowerCase())) {
      seen.add(skill.toLowerCase());
      out.push(skill);
    }
  }
  return out;
}

/** Every skill any listed person has, once each, sorted. */
export function allSkills(members: readonly MemberCapacity[]): string[] {
  const byKey = new Map<string, string>();
  for (const member of members) for (const skill of member.skills) if (!byKey.has(skill.toLowerCase())) byKey.set(skill.toLowerCase(), skill);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

export interface SkillGroup {
  /** Lower-case skill, or '' for people with none. */
  key: string;
  label: string;
  members: MemberCapacity[];
  /** Hours and contract hours per week, summed over the people of the group. */
  hours: number[];
  capacity: number[];
}

/** People grouped by skill; a person with several skills is in each group, one with none in the last. */
export function groupBySkill(members: readonly MemberCapacity[], weekCount: number): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  const add = (key: string, label: string, member: MemberCapacity) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, label, members: [], hours: Array<number>(weekCount).fill(0), capacity: Array<number>(weekCount).fill(0) };
      groups.set(key, group);
    }
    group.members.push(member);
    member.cells.forEach((cell, i) => {
      group.hours[i] += cell.hours;
      group.capacity[i] += member.weeklyHours;
    });
  };
  for (const member of members) {
    if (member.skills.length === 0) add('', '', member);
    for (const skill of member.skills) add(skill.toLowerCase(), skill, member);
  }
  return [...groups.values()].sort(compareSkillGroups);
}

function compareSkillGroups(a: { key: string; label: string }, b: { key: string; label: string }): number {
  if (a.key === '') return 1;
  if (b.key === '') return -1;
  return a.label.localeCompare(b.label);
}

/** Percentage of contract hours, null without any. */
export function percentOf(hours: number, capacity: number): number | null {
  return capacity > 0 ? Math.round((hours / capacity) * 100) : null;
}
