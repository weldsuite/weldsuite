import { Info } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { PreviewBook } from '../asset-math';
import { fill } from '../text';

/** What the server will create when the books are left alone, so the user sees the defaults before saving. */
export function BookDefaultsPreview({ books }: Readonly<{ books: readonly PreviewBook[] }>) {
  const { t } = useI18n();
  const tb = t.weldbooksUs.assets.fixedAssets.books;
  const fa = t.weldbooksUs.assets.fixedAssets;
  const { formatMoney } = useWeldbooksFormat();
  const rules = fa.bonusRules as Record<string, string>;
  const hasMacrs = books.some((book) => book.book === 'federal');

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4" data-testid="book-defaults-preview">
      <div>
        <p className="text-sm font-medium">{tb.defaultsTitle}</p>
        <p className="text-xs text-muted-foreground">{tb.defaultsHelp}</p>
      </div>
      <ul className="space-y-3">
        {books.map((book) => (
          <li key={book.book} className="space-y-1" data-testid={`default-book-${book.book}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{fa.bookKinds[book.book]}</span>
              <Badge variant={book.postsToLedger ? 'secondary' : 'outline'}>
                {book.postsToLedger ? tb.postsToLedger : tb.taxOnly}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {fill(tb.line, {
                method: fa.methods[book.method],
                convention: fa.conventions[book.convention],
                years: book.recoveryYears,
              })}
            </p>
            {book.book === 'federal' ? (
              <p className="text-sm text-muted-foreground">
                {book.section179Amount > 0 ? `${fill(tb.section179Amount, { amount: formatMoney(book.section179Amount) })} · ` : ''}
                {fill(tb.bonus, { percent: book.bonusPercent })}
                {book.bonusRule ? ` (${rules[book.bonusRule]})` : ''}
              </p>
            ) : null}
            {book.convertedToAds ? <p className="text-xs text-amber-700 dark:text-amber-400">{tb.adsConverted}</p> : null}
          </li>
        ))}
      </ul>
      {hasMacrs ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {tb.midQuarterNote}
        </p>
      ) : null}
    </div>
  );
}
