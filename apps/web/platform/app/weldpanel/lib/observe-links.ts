/** Links from the people, frustration and live pages into the recordings list. */

import {
  frustrationRecordingsSearch,
  personRecordingsSearch,
  type PanelDateRange,
  type PanelFrustrationType,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { recordingsHref } from './links';

/** A person's recordings (the profile's "All recordings"). */
export function personRecordingsHref(distinctId: string, projectId?: string): string {
  return recordingsHref(personRecordingsSearch(distinctId, projectId));
}

/** The recordings behind a frustration signal, optionally limited to one page. */
export function frustrationHref(
  type: PanelFrustrationType | 'errors',
  options: { range?: PanelDateRange; page?: string; project?: string } = {},
): string {
  return recordingsHref(frustrationRecordingsSearch(type, { range: options.range, pages: options.page ? [options.page] : undefined, project: options.project }));
}
