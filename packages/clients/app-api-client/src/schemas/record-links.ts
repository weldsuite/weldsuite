/**
 * Where a record lives in the web app, for clients that link to it: the
 * platform's entity sheet falls back to it, and the mobile apps open it in
 * the browser (record cards in chat visuals).
 */

/**
 * The record's full-page path in the web app, or `null` when it has none and
 * is viewed only in its entity sheet (`lead` and `opportunity` lost their
 * `/weldcrm/*` detail routes; helpdesk tickets never had a live one). `type`
 * is a `SearchEntityType`; any other string has no page.
 */
export function recordPagePath(type: string, id: string): string | null {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case 'article':
      return `/welddesk/help-center/articles/${encoded}`;
    case 'invoice':
      return `/weldbooks/invoices/${encoded}`;
    case 'bill':
      return `/weldbooks/bills/${encoded}`;
    case 'project':
      return `/weldflow/project/${encoded}`;
    case 'task':
      return `/weldflow/task/${encoded}`;
    case 'domain':
      return `/weldhost/domains/${encoded}`;
    case 'sheet':
      return `/weldsheets/${encoded}`;
    case 'board':
      return `/weldboard/${encoded}`;
    default:
      return null;
  }
}
