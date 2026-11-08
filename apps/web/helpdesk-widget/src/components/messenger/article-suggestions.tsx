import { useState } from 'react';
import { BookOpen, ChevronDown, ExternalLink } from 'lucide-react';
import type { DeskPublicArticleHit } from '@weldsuite/app-api-client/schemas/desk-knowledge';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils/cn';

/** Only http(s) article links leave the widget. */
function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function Suggestion({ hit, color }: Readonly<{ hit: DeskPublicArticleHit; color: string }>) {
  const [open, setOpen] = useState(false);
  const url = safeUrl(hit.url);
  const rowClass =
    'flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left transition hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none';

  // On the help center: open it there. Without one, the summary is all there is.
  if (url) {
    return (
      <li>
        <a href={url} target="_blank" rel="noopener noreferrer" className={rowClass} title={t.selfService.openArticle}>
          <BookOpen className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" style={{ color }} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-gray-900 truncate">{hit.title}</span>
            {hit.excerpt && <span className="mt-0.5 block text-xs text-gray-500 line-clamp-2">{hit.excerpt}</span>}
          </span>
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
        </a>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={!hit.excerpt}
        title={open ? t.selfService.hideExcerpt : t.selfService.showExcerpt}
        className={cn(rowClass, !hit.excerpt && 'cursor-default hover:bg-transparent')}
      >
        <BookOpen className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" style={{ color }} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={cn('block text-[13px] font-medium text-gray-900', !open && 'truncate')}>{hit.title}</span>
          {open && hit.excerpt && (
            <span className="mt-1 block text-xs text-gray-600 whitespace-pre-wrap break-words">{hit.excerpt}</span>
          )}
        </span>
        {hit.excerpt && (
          <ChevronDown
            className={cn('mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        )}
      </button>
    </li>
  );
}

/**
 * "These articles might help": shown above the composer while the visitor
 * writes the first message of a new conversation (task 1219).
 */
export function ArticleSuggestions({ hits, color }: Readonly<{ hits: DeskPublicArticleHit[]; color: string }>) {
  if (hits.length === 0) return null;
  return (
    <section
      aria-live="polite"
      aria-label={t.selfService.suggestionsTitle}
      className="mb-2 rounded-2xl border border-gray-100 bg-white p-1.5 shadow-[0_2px_12px_rgba(0,0,0,0.06)]"
      data-testid="article-suggestions"
    >
      <p className="px-2.5 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {t.selfService.suggestionsTitle}
      </p>
      <ul>
        {hits.map((hit) => (
          <Suggestion key={hit.id} hit={hit} color={color} />
        ))}
      </ul>
    </section>
  );
}
