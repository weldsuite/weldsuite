import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, ExternalLink, Link2, Loader2, Search } from 'lucide-react';
import type { DeskArticleSuggestion } from '@weldsuite/app-api-client/schemas/desk-knowledge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { useDebounce } from '@/hooks/use-debounce';
import { useDeskArticleSuggestions } from '@/hooks/queries/use-desk-knowledge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';

const VISIBILITY_TONE: Record<string, SoftTone> = {
  public: 'success',
  logged_in: 'neutral',
  groups: 'warning',
};

interface KnowledgeButtonProps {
  conversationId: string;
  /** Appends text (an article's link) to the reply box. */
  onInsert: (text: string) => void;
}

/**
 * The composer's Knowledge button: articles suggested for the conversation
 * (from the customer's latest messages) or found by a search, each with
 * "Insert link" for its public help-center page.
 */
export function KnowledgeButton({ conversationId, onInsert }: Readonly<KnowledgeButtonProps>) {
  const { t } = useI18n();
  const k = t.helpdesk.knowledgeInbox;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 250);
  const suggestions = useDeskArticleSuggestions(conversationId, debounced, open);

  useEffect(() => {
    setOpen(false);
    setSearch('');
  }, [conversationId]);

  const data = suggestions.data;
  const articles = data?.articles ?? [];
  const searching = debounced.trim().length > 0;

  const insert = (article: DeskArticleSuggestion) => {
    if (!article.url) return;
    onInsert(`${article.title}: ${article.url}`);
    setOpen(false);
  };

  let body: ReactNode;
  if (suggestions.isLoading) {
    body = (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {k.loading}
      </div>
    );
  } else if (suggestions.isError) {
    body = <p className="px-3 py-6 text-center text-sm text-muted-foreground">{k.loadError}</p>;
  } else if (articles.length === 0) {
    body = (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">{searching ? k.empty : k.noSuggestions}</p>
    );
  } else {
    body = (
      <ul className="max-h-72 overflow-y-auto py-1" data-testid="desk-knowledge-results">
        {articles.map((article) => (
          <li key={article.id} className="px-3 py-2 hover:bg-muted/50">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate text-sm font-medium">{article.title}</span>
              <SoftBadge tone={VISIBILITY_TONE[article.visibility] ?? 'neutral'} className="flex-shrink-0 text-[10px]">
                {k.visibility[article.visibility as keyof typeof k.visibility] ?? article.visibility}
              </SoftBadge>
              {article.locale && (
                <span className="flex-shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{article.locale}</span>
              )}
            </div>
            {article.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{article.excerpt}</p>}
            <div className="mt-1.5 flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={!article.url}
                onClick={() => insert(article)}
              >
                <Link2 className="mr-1 h-3 w-3" />
                {k.insertLink}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground" asChild>
                {article.url ? (
                  <a href={article.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-1 h-3 w-3" />
                    {k.openArticle}
                  </a>
                ) : (
                  <Link href={`/welddesk/help-center/articles/${article.id}`}>
                    <ExternalLink className="mr-1 h-3 w-3" />
                    {k.openArticle}
                  </Link>
                )}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          title={k.button}
          aria-label={k.button}
          data-testid="desk-inbox-composer-knowledge"
        >
          <BookOpen className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[min(440px,calc(100vw-32px))] p-0">
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={k.searchPlaceholder}
              className="h-8 pl-8 text-sm"
              autoFocus
            />
          </div>
        </div>
        <p className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {searching ? k.results : k.suggested}
        </p>
        {body}
        {data && !data.helpCenterUrl && (
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {k.noHelpCenter}{' '}
            <Link href="/settings/apps/welddesk/help-center" className="text-primary underline-offset-2 hover:underline">
              {k.setUpHelpCenter}
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
