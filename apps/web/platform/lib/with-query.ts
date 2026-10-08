/** `path` with `?query` appended, or `path` alone when the query string is empty. */
export function withQuery(path: string, query: string): string {
  return query ? `${path}?${query}` : path;
}
