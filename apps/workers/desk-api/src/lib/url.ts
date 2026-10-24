/** `https://host/` → `https://host` (a loop, not `/\/+$/`, which backtracks). */
export function withoutTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
