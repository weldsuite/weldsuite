import { en } from '@weldsuite/i18n/locales/en';
import { getTranslations } from '@/lib/i18n';

export type BlockEditorStrings = typeof en.blockEditor;

/**
 * The editor's strings in the active language. Partial locales (fr) have no
 * `blockEditor` namespace and nothing merges them over English, so fall back
 * here rather than crash a page that merely contains a callout.
 */
export function getBlockEditorStrings(): BlockEditorStrings {
  return (getTranslations('blockEditor') as BlockEditorStrings | undefined) ?? en.blockEditor;
}
