/**
 * Neutralises a value before it is interpolated into a log line.
 *
 * Line breaks (and the Unicode line/paragraph separators) are replaced so a
 * value coming from a request, webhook or third-party payload cannot forge
 * extra log entries.
 */
import { asText } from '@weldsuite/text';
export function logSafe(value: unknown): string {
  return asText(value).replace(/[\r\n\u2028\u2029]+/g, ' ');
}
