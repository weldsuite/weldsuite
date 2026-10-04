/**
 * Chrome's native i18n. The browser picks `_locales/<lang>/messages.json`
 * (emitted from src/locales at build time); the bundled English copy is the
 * fallback for code running outside an extension, which is the unit tests.
 */

import en from '../locales/en.json';

export type MessageKey = keyof typeof en;

function fallback(key: MessageKey, substitutions: string[]): string {
  return en[key].message.replace(
    /\$(\d)/g,
    (_match, index: string) => substitutions[Number(index) - 1] ?? '',
  );
}

export function t(key: MessageKey, ...substitutions: Array<string | number>): string {
  const values = substitutions.map(String);
  const native =
    typeof chrome !== 'undefined' && chrome.i18n ? chrome.i18n.getMessage(key, values) : '';
  return native || fallback(key, values);
}
