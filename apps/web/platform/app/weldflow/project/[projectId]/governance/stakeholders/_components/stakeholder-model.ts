/**
 * What the stakeholder screens work out from the register: the toolbar's
 * search and filters, the power / interest quadrant of a person, the pill
 * colours of attitude and engagement, and the RACI row a cell change produces.
 * Pure functions, so the list, the grid, the panel and the tests agree.
 */

import type { ActiveFilter } from '@weldsuite/ui/components/list-toolbar';
import type { RaciLetter, RaciSubject, Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import { TONE_PILL } from '../../../raid/_lib/styles';

// ── Toolbar: search and filters ─────────────────────────────────────────────

/** The fields the toolbar's Filter button offers. */
export const STAKEHOLDER_FILTER_FIELDS = { attitude: 'attitude', engagement: 'engagement', type: 'type' } as const;

/** The two sides of the register: members of the team, and client contacts. */
export type StakeholderSide = 'internal' | 'client';

export function sideOf(row: Pick<Stakeholder, 'kind'>): StakeholderSide {
  return row.kind === 'member' ? 'internal' : 'client';
}

/** A filter the Filter button is still building (no operator or value yet) narrows nothing. */
function isComplete(filter: ActiveFilter): boolean {
  return filter.operator !== '' && filter.value !== '';
}

function filterValue(row: Stakeholder, field: string): string | null {
  if (field === STAKEHOLDER_FILTER_FIELDS.attitude) return row.attitude;
  if (field === STAKEHOLDER_FILTER_FIELDS.engagement) return row.engagement;
  if (field === STAKEHOLDER_FILTER_FIELDS.type) return sideOf(row);
  return null;
}

/** Each filter narrows the list in turn: `is` keeps the matches, `is not` drops them. */
function matchesFilter(row: Stakeholder, filter: ActiveFilter): boolean {
  const value = filterValue(row, filter.field);
  if (value === null) return true;
  return filter.operator === 'is not' ? value !== filter.value : value === filter.value;
}

function searchText(row: Stakeholder): string {
  return [row.name, row.role, row.organisation]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
}

/** The rows that pass the search (name, role, organisation) and every complete filter. */
export function applyStakeholderFilters(rows: readonly Stakeholder[], search: string, filters: readonly ActiveFilter[]): Stakeholder[] {
  const query = search.trim().toLowerCase();
  const active = filters.filter(isComplete);
  return rows.filter((row) => (!query || searchText(row).includes(query)) && active.every((filter) => matchesFilter(row, filter)));
}

// ── Power / interest grid ───────────────────────────────────────────────────

/** A score of this or more is "high" on the grid. */
export const HIGH_SCORE = 4;

/** The grid's quadrants, as the keys of `copy.grid`, in the order they are drawn (row by row). */
export const QUADRANTS = ['keepSatisfied', 'manageClosely', 'monitor', 'keepInformed'] as const;
export type Quadrant = (typeof QUADRANTS)[number];

/** High influence is on the top row, high interest on the right. */
export function quadrantOf(row: Pick<Stakeholder, 'influence' | 'interest'>): Quadrant {
  const influential = row.influence >= HIGH_SCORE;
  const interested = row.interest >= HIGH_SCORE;
  if (influential) return interested ? 'manageClosely' : 'keepSatisfied';
  return interested ? 'keepInformed' : 'monitor';
}

// ── Pills ───────────────────────────────────────────────────────────────────

export const ATTITUDE_PILL: Readonly<Record<Stakeholder['attitude'], string>> = {
  supportive: TONE_PILL.green,
  neutral: TONE_PILL.neutral,
  resistant: TONE_PILL.red,
};

export const ENGAGEMENT_PILL: Readonly<Record<Stakeholder['engagement'], string>> = {
  unaware: TONE_PILL.orange,
  resistant: TONE_PILL.red,
  neutral: TONE_PILL.neutral,
  supportive: TONE_PILL.green,
  leading: TONE_PILL.blue,
};

/** Who the person is on screen: their name, else their email, else nothing. */
export function stakeholderName(row: Pick<Stakeholder, 'name' | 'email'>): string {
  return row.name ?? row.email ?? '';
}

/**
 * The day of a last contact, in the user's language. The form saves the day as
 * midnight UTC, so it is read back in UTC: in a zone behind UTC the local day
 * would be the one before.
 */
export function formatContactDate(iso: string | null | undefined, intlLocale: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
}

/** The `4 / 5` of the list and the panel. */
export function scoreText(row: Pick<Stakeholder, 'influence' | 'interest'>): string {
  return `${row.influence} / ${row.interest}`;
}

// ── RACI ────────────────────────────────────────────────────────────────────

export const RACI_CELL_LETTERS: ReadonlyArray<RaciLetter | ''> = ['', 'R', 'A', 'C', 'I'];

/**
 * The whole row of a subject after one cell changed (the API takes the row,
 * not the cell): the person's letter is replaced, or dropped for an empty
 * letter, and an `A` taken by another person moves, as a row has only one.
 */
export function assignmentsAfter(subject: RaciSubject, stakeholderId: string, letter: RaciLetter | ''): RaciSubject['assignments'] {
  const others = subject.assignments.filter((assignment) => assignment.stakeholderId !== stakeholderId);
  if (!letter) return others;
  return [...others.filter((assignment) => !(letter === 'A' && assignment.letter === 'A')), { stakeholderId, letter }];
}

/** What a row of the matrix is called: a deliverable by its code and title, the two standing rows by their names. */
export function raciSubjectTitle(subject: RaciSubject, names: { changeRequests: string; goLive: string }): string {
  if (subject.subjectType === 'deliverable') return `${subject.code ?? ''} ${subject.title ?? ''}`.trim();
  return subject.subjectType === 'change_requests' ? names.changeRequests : names.goLive;
}
