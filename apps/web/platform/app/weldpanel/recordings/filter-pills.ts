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

/** The pills a search shows, in a stable order. */
export function searchToFilters(search: RecordingsSearch): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const add = (field: string, operator: string, value: string) => out.push({ id: `${field}:${operator}:${value}`, field, operator, value });
  if (search.from && search.to) add('period', 'is', `${search.from}${CUSTOM_RANGE_SEPARATOR}${search.to}`);
  else if (search.range) add('period', 'is', search.range);
  for (const device of search.devices ?? []) add('device', 'is', device);
  for (const country of search.countries ?? []) add('country', 'is', country);
  for (const browser of search.browsers ?? []) add('browser', 'is', browser);
  for (const type of search.frustration ?? []) add('frustration', 'is', type);
  if (search.errors) add('errors', 'is', 'true');
  if (search.favorites) add('favorites', 'is', 'true');
  if (search.cohort) add('cohort', 'is', search.cohort);
  for (const name of search.did ?? []) add('event', 'is', name);
  for (const name of search.didNot ?? []) add('event', 'is not', name);
  if (search.entryPage) add('entryPage', 'is', search.entryPage);
  if (search.exitPage) add('exitPage', 'is', search.exitPage);
  for (const page of search.pages ?? []) add('page', 'is', page);
  if (search.minDuration !== undefined) add('minDuration', 'gt', String(search.minDuration));
  if (search.maxDuration !== undefined) add('maxDuration', 'lt', String(search.maxDuration));
  return out;
}

function seconds(raw: string): number | undefined {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * The search the pills describe, keeping what isn't a pill (project, person,
 * sort). Unfinished pills (no operator or value yet) change nothing.
 */
export function filtersToSearch(filters: ActiveFilter[], base: RecordingsSearch): RecordingsSearch {
  const next: RecordingsSearch = { project: base.project, user: base.user, sort: base.sort };
  const done = filters.filter((f) => f.operator && f.value !== '');
  const values = (field: string, operator = 'is') => done.filter((f) => f.field === field && f.operator === operator).map((f) => f.value);
  const last = (field: string, operator = 'is') => values(field, operator).at(-1);

  const period = last('period');
  if (period?.includes(CUSTOM_RANGE_SEPARATOR)) {
    const [from, to] = period.split(CUSTOM_RANGE_SEPARATOR);
    next.from = from;
    next.to = to;
  } else if (period) {
    next.range = period as RecordingsSearch['range'];
  }

  const included = values('device') as Device[];
  const excluded = new Set(values('device', 'is not'));
  const devices = (included.length > 0 ? included : excluded.size > 0 ? [...DEVICES] : []).filter((d) => !excluded.has(d));
  if (devices.length > 0) next.devices = unique(devices) as Device[];

  const countries = values('country');
  if (countries.length > 0) next.countries = unique(countries);
  const browsers = values('browser');
  if (browsers.length > 0) next.browsers = unique(browsers);
  const frustration = values('frustration');
  if (frustration.length > 0) next.frustration = unique(frustration) as RecordingsSearch['frustration'];
  if (last('errors') === 'true') next.errors = true;
  if (last('favorites') === 'true') next.favorites = true;
  const cohort = last('cohort');
  if (cohort) next.cohort = cohort;
  const did = values('event');
  if (did.length > 0) next.did = unique(did);
  const didNot = values('event', 'is not');
  if (didNot.length > 0) next.didNot = unique(didNot);
  const entryPage = last('entryPage');
  if (entryPage) next.entryPage = entryPage;
  const exitPage = last('exitPage');
  if (exitPage) next.exitPage = exitPage;
  const pages = values('page');
  if (pages.length > 0) next.pages = unique(pages);
  const min = seconds(last('minDuration', 'gt') ?? '');
  if (min !== undefined) next.minDuration = min;
  const max = seconds(last('maxDuration', 'lt') ?? '');
  if (max !== undefined) next.maxDuration = max;
  return next;
}
