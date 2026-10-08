import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import type { BookKind } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';

export interface IssueLike {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  book?: BookKind;
  stateCode?: string | null;
}

/** The issue in the user's language when the code is known, else the server's own message. */
export function useIssueText() {
  const { t } = useI18n();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const known = fa.issues as Record<string, string>;
  const books = fa.bookKinds;
  return (issue: IssueLike): string => {
    const text = known[issue.code] ?? issue.message;
    if (!issue.book) return text;
    const label = issue.book === 'state' && issue.stateCode ? `${books.state} ${issue.stateCode}` : books[issue.book];
    return `${label}: ${text}`;
  };
}

/** Warnings and errors raised while the depreciation books were built, each once. */
export function IssueList({ issues, title }: Readonly<{ issues: readonly IssueLike[]; title: string }>) {
  const textOf = useIssueText();
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = `${issue.book ?? ''}:${issue.stateCode ?? ''}:${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return null;
  return (
    <Alert data-testid="asset-issues">
      <AlertTriangle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          {unique.map((issue) => (
            <li key={`${issue.book ?? ''}:${issue.stateCode ?? ''}:${issue.code}`}>{textOf(issue)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
