/** The Results tab's search parameter: which sub-tab is open. */

export const RESULTS_TABS = ['summary', 'responses', 'insights'] as const;
export type ResultsTab = (typeof RESULTS_TABS)[number];

export interface ResultsSearch {
  tab: ResultsTab;
}

export function parseResultsSearch(search: Record<string, unknown>): ResultsSearch {
  const tab = RESULTS_TABS.find((value) => value === search.tab);
  return { tab: tab ?? 'summary' };
}
