import type { DefinitionIssue } from '@weldsuite/forms-engine';
import { useI18n } from '@/lib/i18n/provider';

/** A definition issue in the member's language; unknown codes fall back to the engine's English message. */
export function useIssueText(): (issue: DefinitionIssue) => string {
  const { t } = useI18n();
  const texts = t.weldforms.issues as Record<string, string>;
  return (issue) => texts[issue.code] ?? issue.message;
}
