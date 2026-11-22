import { useMemo, type ReactNode } from 'react';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { useDebounce } from '@/hooks/use-debounce';
import {
  useCategoryMembersPreview,
  type CategoryMembersPreviewInput,
  type CategoryRule,
  type CategoryRulesMatch,
} from '@/hooks/queries/use-commerce-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { cleanRules, rulesAreComplete } from '../../lib/categories';

/** How many matching products the preview names. */
const SHOWN = 5;

/**
 * The products an unsaved rule set matches, asked of the server a moment
 * after the rules stop changing, and only while every rule is complete.
 */
export function CategoryMembersPreview({
  rules,
  rulesMatch,
}: Readonly<{ rules: CategoryRule[]; rulesMatch: CategoryRulesMatch }>) {
  const t = getTranslations('commerce').categories.rules.preview;
  const input = useMemo<CategoryMembersPreviewInput | null>(
    () => (rulesAreComplete(rules) ? { rules: cleanRules(rules), rulesMatch } : null),
    [rules, rulesMatch],
  );
  const debounced = useDebounce(input, 400);
  const { data, isLoading, error } = useCategoryMembersPreview(debounced);

  // Only the outcome line is announced (`outcome`, in the live region); the hint, the
  // spinner and the product names (`detail`) are not, so each change reads as one sentence.
  let outcome: ReactNode = null;
  let detail: ReactNode = null;
  if (input === null) {
    detail = <p className="text-xs text-muted-foreground">{t.incomplete}</p>;
  } else if (debounced !== input || isLoading) {
    detail = <InlineSpinner className="justify-start py-1" />;
  } else if (error || !data) {
    outcome = <InlineError className="text-xs">{t.failed}</InlineError>;
  } else {
    const { totalCount, products } = data.data;
    const shown = products.slice(0, SHOWN);
    if (totalCount === 0) {
      outcome = <p className="text-xs text-muted-foreground">{t.none}</p>;
    } else {
      outcome = <p className="font-medium">{plural(totalCount, t.count, getLocale())}</p>;
      detail = (
        <>
          <ul className="mt-1 grid gap-0.5 text-muted-foreground">
            {shown.map((product) => (
              <li key={product.id} className="truncate">
                {product.name}
                {product.sku ? ` · ${product.sku}` : ''}
              </li>
            ))}
          </ul>
          {totalCount > shown.length && (
            <p className="mt-1 text-xs text-muted-foreground">
              {plural(totalCount - shown.length, t.more, getLocale())}
            </p>
          )}
        </>
      );
    }
  }

  return (
    <section className="rounded-md bg-muted/40 p-3 text-sm">
      <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.title}</h4>
      {/* Always in the page, so a changed outcome is announced (a live region that appears isn't, reliably). */}
      <div role="status">{outcome}</div>
      {detail}
    </section>
  );
}
