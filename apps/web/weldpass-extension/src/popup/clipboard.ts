import { t } from '../lib/i18n';
import type { Notify } from './hooks';

/** Copies `text` and says so in the status line, or says the copy failed. */
export async function copyText(text: string, done: string, notify: Notify): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify('ok', done);
  } catch {
    notify('error', t('copyFailed'));
  }
}
