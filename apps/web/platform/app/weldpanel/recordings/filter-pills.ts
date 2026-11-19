/**
 * The recordings filters as the standard list's Filter pills: every filter of
 * the URL search (`RecordingsSearch`) is one pill, and the pills write back to
 * the search, so links into Recordings (a funnel drop-off, a frustration
 * chart, a person's sessions) still land filtered.
 *
 * Values the API can only include get just the `is` operator; devices and
 * events also take `is not` (the other devices; "did not do").
 */

import { PANEL_DATE_PRESETS, PANEL_FRUSTRATION_TYPES, type RecordingsSearch } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { ActiveFilter, FilterConfig } from '@/components/panel-entity-list';

const DEVICES = ['desktop', 'tablet', 'mobile'] as const;
type Device = (typeof DEVICES)[number];

/** `from..to`: a custom range carried in from a link, shown as one period pill. */
const CUSTOM_RANGE_SEPARATOR = '..';

export interface RecordingsFilterLabels {
  period: string;
  presets: Record<(typeof PANEL_DATE_PRESETS)[number], string>;
  customRange: (from: string, to: string) => string;
  devices: string;
  deviceNames: Record<Device, string>;
  countries: string;
  countryName: (code: string) => string;
  browsers: string;
  frustration: string;
  frustrationTypes: Record<(typeof PANEL_FRUSTRATION_TYPES)[number], string>;
  errors: string;
  favorites: string;
  cohort: string;
  event: string;
  entryPage: string;
  exitPage: string;
  page: string;
  minDuration: string;
  maxDuration: string;
}

export interface RecordingsFilterOptions {
  cohorts: { id: string; name: string }[];
  events: string[];
  countries: string[];
  browsers: string[];
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function recordingsFilterConfigs(search: RecordingsSearch, labels: RecordingsFilterLabels, options: RecordingsFilterOptions): FilterConfig[] {
  const custom = search.from && search.to ? `${search.from}${CUSTOM_RANGE_SEPARATOR}${search.to}` : null;
  return [
    {
      field: 'period',
      label: labels.period,
      operators: ['is'],
      options: [
        ...PANEL_DATE_PRESETS.map((preset) => ({ value: preset, label: labels.presets[preset] })),
        ...(custom ? [{ value: custom, label: labels.customRange(search.from!, search.to!) }] : []),
      ],
    },
    { field: 'device', label: labels.devices, options: DEVICES.map((d) => ({ value: d, label: labels.deviceNames[d] })) },
    {
      field: 'country',
      label: labels.countries,
      operators: ['is'],
      searchable: true,
      options: unique([...options.countries, ...(search.countries ?? [])]).map((code) => ({ value: code, label: labels.countryName(code) })),
    },
    {
      field: 'browser',
      label: labels.browsers,
      operators: ['is'],
      options: unique([...options.browsers, ...(search.browsers ?? [])]).map((name) => ({ value: name, label: name })),
    },
    {
      field: 'frustration',
      label: labels.frustration,
      operators: ['is'],
      options: PANEL_FRUSTRATION_TYPES.map((type) => ({ value: type, label: labels.frustrationTypes[type] })),
    },
    { field: 'errors', label: labels.errors, filterType: 'boolean', options: [] },
    { field: 'favorites', label: labels.favorites, filterType: 'boolean', options: [] },
    {
      field: 'cohort',
      label: labels.cohort,
      operators: ['is'],
      options: options.cohorts.map((cohort) => ({ value: cohort.id, label: cohort.name })),
    },
    {
      field: 'event',
      label: labels.event,
      searchable: true,
      options: unique([...options.events, ...(search.did ?? []), ...(search.didNot ?? [])]).map((name) => ({ value: name, label: name })),
    },
    { field: 'entryPage', label: labels.entryPage, filterType: 'text', operators: ['is'], options: [] },
    { field: 'exitPage', label: labels.exitPage, filterType: 'text', operators: ['is'], options: [] },
    { field: 'page', label: labels.page, filterType: 'text', operators: ['is'], options: [] },
    { field: 'minDuration', label: labels.minDuration, filterType: 'number', operators: ['gt'], options: [] },
    { field: 'maxDuration', label: labels.maxDuration, filterType: 'number', operators: ['lt'], options: [] },
  ];
}

const one = (value: string | undefined): string[] => (value ? [value] : []);
const flag = (on: boolean | undefined): string[] => (on ? ['true'] : []);
const amount = (n: number | undefined): string[] => (n === undefined ? [] : [String(n)]);

/** Every pill but the period's, in the order they show: field, operator, and the values a search gives it. */
const SEARCH_PILLS: readonly (readonly [field: string, operator: string, values: (search: RecordingsSearch) => readonly string[]])[] = [
  ['device', 'is', (s) => s.devices ?? []],
  ['country', 'is', (s) => s.countries ?? []],
  ['browser', 'is', (s) => s.browsers ?? []],
  ['frustration', 'is', (s) => s.frustration ?? []],
  ['errors', 'is', (s) => flag(s.errors)],
  ['favorites', 'is', (s) => flag(s.favorites)],
  ['cohort', 'is', (s) => one(s.cohort)],
  ['event', 'is', (s) => s.did ?? []],
  ['event', 'is not', (s) => s.didNot ?? []],
  ['entryPage', 'is', (s) => one(s.entryPage)],
  ['exitPage', 'is', (s) => one(s.exitPage)],
  ['page', 'is', (s) => s.pages ?? []],
  ['minDuration', 'gt', (s) => amount(s.minDuration)],
  ['maxDuration', 'lt', (s) => amount(s.maxDuration)],
];

/** The period pill's value: a custom range as `from..to`, else the preset. */
function periodValue(search: RecordingsSearch): string | undefined {
  if (search.from && search.to) return `${search.from}${CUSTOM_RANGE_SEPARATOR}${search.to}`;
  return search.range;
}

/** The pills a search shows, in a stable order. */
export function searchToFilters(search: RecordingsSearch): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const add = (field: string, operator: string, value: string) => out.push({ id: `${field}:${operator}:${value}`, field, operator, value });
  const period = periodValue(search);
  if (period) add('period', 'is', period);
  for (const [field, operator, values] of SEARCH_PILLS) {
    for (const value of values(search)) add(field, operator, value);
  }
  return out;
}

function seconds(raw: string): number | undefined {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** The period pills write: a `from..to` range, or a preset. */
function periodSearch(period: string | undefined): Pick<RecordingsSearch, 'from' | 'to' | 'range'> {
  if (!period) return {};
  if (!period.includes(CUSTOM_RANGE_SEPARATOR)) return { range: period as RecordingsSearch['range'] };
  const [from, to] = period.split(CUSTOM_RANGE_SEPARATOR);
  return { from, to };
}

/** Devices: the ones picked with `is`, or all of them when only `is not` is used, less the excluded ones. */
function deviceSearch(included: string[], excluded: Set<string>): Device[] | undefined {
  let base: readonly string[] = included;
  if (included.length === 0) base = excluded.size > 0 ? DEVICES : [];
  const devices = unique(base.filter((d) => !excluded.has(d)));
  return devices.length > 0 ? (devices as Device[]) : undefined;
}

/** `values` without duplicates, or nothing when empty, so the search leaves the key out. */
const listOrNothing = (values: string[]): string[] | undefined => (values.length > 0 ? unique(values) : undefined);

/** Drops the keys that are `undefined` (or `false`), so an unset filter is absent from the search, not set to nothing. */
function withoutEmpty(search: RecordingsSearch): RecordingsSearch {
  return Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined && value !== false)) as RecordingsSearch;
}

/**
 * The search the pills describe, keeping what isn't a pill (project, person,
 * sort). Unfinished pills (no operator or value yet) change nothing.
 */
export function filtersToSearch(filters: ActiveFilter[], base: RecordingsSearch): RecordingsSearch {
  const done = filters.filter((f) => f.operator && f.value !== '');
  const values = (field: string, operator = 'is') => done.filter((f) => f.field === field && f.operator === operator).map((f) => f.value);
  const last = (field: string, operator = 'is') => values(field, operator).at(-1);

  return withoutEmpty({
    project: base.project,
    user: base.user,
    sort: base.sort,
    ...periodSearch(last('period')),
    devices: deviceSearch(values('device'), new Set(values('device', 'is not'))),
    countries: listOrNothing(values('country')),
    browsers: listOrNothing(values('browser')),
    frustration: listOrNothing(values('frustration')) as RecordingsSearch['frustration'],
    errors: last('errors') === 'true',
    favorites: last('favorites') === 'true',
    cohort: last('cohort') || undefined,
    did: listOrNothing(values('event')),
    didNot: listOrNothing(values('event', 'is not')),
    entryPage: last('entryPage') || undefined,
    exitPage: last('exitPage') || undefined,
    pages: listOrNothing(values('page')),
    minDuration: seconds(last('minDuration', 'gt') ?? ''),
    maxDuration: seconds(last('maxDuration', 'lt') ?? ''),
  });
}
