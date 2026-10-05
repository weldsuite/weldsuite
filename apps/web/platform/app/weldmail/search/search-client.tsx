
import { useMemo, useState } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { Search, Paperclip, Star, X, AlertCircle, Loader2, Mail } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router';
import { useDebounce } from '@/hooks/use-debounce';
import { useMailSearch } from '@/hooks/queries/use-mail-search-queries';
import { getLabelDisplayName } from '../lib/label-config';
import {
  MAIL_SEARCH_DEBOUNCE_MS,
  normalizeSearchQuery,
  toMailSearchResult,
} from './mail-search-utils';

export function SearchClient() {
  const { t, plural } = useI18n();

  useBreadcrumbs([
    { label: t.mail.inboxPage.mailBreadcrumb, href: '/weldmail' },
    { label: t.mail.search.title },
  ]);

  const [searchQuery, setSearchQuery] = useState('');
  const [hasAttachments, setHasAttachments] = useState(false);
  const [isStarred, setIsStarred] = useState(false);

  const debouncedQuery = useDebounce(searchQuery, MAIL_SEARCH_DEBOUNCE_MS);
  const filters = useMemo(() => ({ hasAttachments, isStarred }), [hasAttachments, isStarred]);

  const search = useMailSearch(debouncedQuery, filters);
  const hasQuery = normalizeSearchQuery(debouncedQuery).length > 0;

  const results = useMemo(
    () => (search.data?.pages ?? []).flatMap((page) => page.data.map(toMailSearchResult)),
    [search.data],
  );
  const totalCount = search.data?.pages[0]?.pagination?.totalCount ?? results.length;

  // The typed query is ahead of the one being searched while the debounce runs.
  const isTyping = normalizeSearchQuery(searchQuery) !== normalizeSearchQuery(debouncedQuery);

  const hasFilters = hasAttachments || isStarred;
  const clearFilters = () => {
    setHasAttachments(false);
    setIsStarred(false);
  };

  const renderBody = () => {
    if (!hasQuery) {
      return (
        <Card className="p-12">
          <div className="flex flex-col items-center justify-center text-center text-muted-foreground">
            <Mail className="h-12 w-12 mb-4" />
            <p className="text-lg font-medium">{t.mail.search.promptTitle}</p>
            <p className="text-sm mt-2">{t.mail.search.promptDescription}</p>
          </div>
        </Card>
      );
    }

    if (search.isError) {
      return (
        <Card className="p-12" role="alert">
          <div className="flex flex-col items-center justify-center text-center text-muted-foreground">
            <AlertCircle className="h-12 w-12 mb-4 text-destructive" />
            <p className="text-lg font-medium">{t.mail.search.searchFailed}</p>
            <p className="text-sm mt-2">{t.mail.search.searchFailedDescription}</p>
            <Button variant="outline" className="mt-4" onClick={() => search.refetch()}>
              {t.mail.search.retry}
            </Button>
          </div>
        </Card>
      );
    }

    if (search.isLoading || isTyping) {
      return (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">{t.mail.search.searching}</span>
        </div>
      );
    }

    if (results.length === 0) {
      return (
        <Card className="p-12">
          <div className="flex flex-col items-center justify-center text-center text-muted-foreground">
            <AlertCircle className="h-12 w-12 mb-4" />
            <p className="text-lg font-medium">{t.mail.search.noResults}</p>
            <p className="text-sm mt-2">{t.mail.search.tryAdjusting}</p>
          </div>
        </Card>
      );
    }

    return (
      <>
        <div className="text-sm text-muted-foreground mb-4">
          {plural(totalCount, t.common.plurals.searchResults)}
        </div>
        <div className="space-y-2">
          {results.map((email) => (
            <Link key={email.id} href={email.href} className="block">
              <Card className="hover:bg-accent transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback>
                        {(email.from[0] ?? '?').toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={cn('text-sm truncate', !email.isRead && 'font-semibold')}>
                              {email.from || t.mail.shared.unknown}
                            </span>
                            {email.isStarred && (
                              <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400 dark:fill-yellow-300 dark:text-yellow-300" />
                            )}
                            {email.hasAttachments && (
                              <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                            )}
                          </div>
                          <div className={cn('text-sm truncate', !email.isRead && 'font-semibold')}>
                            {email.subject || t.mail.shared.noSubject}
                          </div>
                        </div>
                        {email.date && (
                          <span className="text-xs text-muted-foreground shrink-0">
                            {format(email.date, 'MMM d, yyyy')}
                          </span>
                        )}
                      </div>
                      {email.preview && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{email.preview}</p>
                      )}
                      <div className="flex gap-1 mt-2">
                        <Badge variant="outline" className="text-xs">
                          {getLabelDisplayName(email.folder)}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
        {search.hasNextPage && (
          <div className="flex justify-center mt-4">
            <Button
              variant="outline"
              onClick={() => search.fetchNextPage()}
              disabled={search.isFetchingNextPage}
            >
              {search.isFetchingNextPage ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t.mail.search.loadingMore}
                </>
              ) : (
                t.mail.search.loadMore
              )}
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-4">{t.mail.search.searchHeader}</h1>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            placeholder={t.mail.search.searchAllMail}
            className="pl-9 pr-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.mail.search.clearFilters}
              onClick={() => setSearchQuery('')}
              className="absolute right-1 top-1/2 -translate-y-1/2"
            >
              <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={hasAttachments ? 'default' : 'outline'}
            size="sm"
            aria-pressed={hasAttachments}
            onClick={() => setHasAttachments((value) => !value)}
          >
            <Paperclip className="h-4 w-4 mr-1" />
            {t.mail.search.hasAttachments}
          </Button>
          <Button
            variant={isStarred ? 'default' : 'outline'}
            size="sm"
            aria-pressed={isStarred}
            onClick={() => setIsStarred((value) => !value)}
          >
            <Star className="h-4 w-4 mr-1" />
            {t.mail.search.starred}
          </Button>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t.mail.search.clearFilters}
            </Button>
          )}
        </div>
      </div>

      <div>{renderBody()}</div>
    </div>
  );
}
