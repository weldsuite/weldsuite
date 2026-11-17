/** The Logic tab's URL state: whose rules are open beside the flow (a block id, or `endings`). */

export const ENDINGS = 'endings';

export interface LogicSearch {
  block?: string;
}

export function parseLogicSearch(search: Record<string, unknown>): LogicSearch {
  return typeof search.block === 'string' && search.block !== '' ? { block: search.block } : {};
}
