import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Languages, Loader2, Plus } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { DESK_ARTICLE_LANGUAGES } from '@weldsuite/app-api-client/schemas/desk-knowledge';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useArticleTranslations, useCreateArticleTranslation } from '@/hooks/queries/use-desk-knowledge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';

/** A language tag's name in the UI language (`nl` → "Dutch"); the tag itself when the browser has no name for it. */
export function useLanguageName(): (locale: string) => string {
  const { language } = useI18n();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([language], { type: 'language' });
    } catch {
      names = null;
    }
    return (locale: string) => {
      try {
        return names?.of(locale) ?? locale;
      } catch {
        return locale;
      }
    };
  }, [language]);
}

interface ArticleLanguagesProps {
  /** The article being edited (`new` before its first save). */
  articleId: string;
}

/**
 * The editor's "Language versions": the original and its translations, each
 * opening its own editor, and "Add language" creating a draft version (the
 * original's title and content, for the translator to replace).
 */
export function ArticleLanguages({ articleId }: Readonly<ArticleLanguagesProps>) {
  const { t } = useI18n();
  const a = t.helpdesk.articleAudience;
  const router = useRouter();
  const languageName = useLanguageName();
  const isNew = articleId === 'new';
  const versions = useArticleTranslations(articleId, !isNew);
  const create = useCreateArticleTranslation();
  const [pending, setPending] = useState<string | null>(null);

  if (isNew) {
    return <p className="text-xs text-muted-foreground">{a.saveFirst}</p>;
  }

  const rows = versions.data ?? [];
  const original = rows.find((row) => !row.translationOfId);
  const taken = new Set(rows.map((row) => row.locale).filter((locale): locale is string => !!locale));
  const available = DESK_ARTICLE_LANGUAGES.filter((locale) => !taken.has(locale));

  const add = async (locale: string) => {
    setPending(locale);
    try {
      const created = await create.mutateAsync({ articleId: original?.id ?? articleId, locale });
      toast.success(a.translationCreated);
      router.push(`/welddesk/help-center/articles/${created.id}/edit`);
    } catch (error) {
      toast.error(isApiError(error) && error.status === 409 ? a.translationExists : a.translationFailed);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="article-language-versions">
      <p className="text-xs text-muted-foreground">{a.translationsHint}</p>
      {versions.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {a.loadingVersions}
        </div>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => {
            const current = row.id === articleId;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  disabled={current}
                  onClick={() => router.push(`/welddesk/help-center/articles/${row.id}/edit`)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    current ? 'bg-muted' : 'hover:bg-muted/60',
                  )}
                >
                  <Languages className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">
                    {row.locale ? languageName(row.locale) : a.defaultLanguage}
                    {!row.translationOfId && <span className="text-muted-foreground"> · {a.original}</span>}
                  </span>
                  <Badge variant="outline" className="flex-shrink-0 text-[10px] capitalize">
                    {current ? a.thisVersion : row.status}
                  </Badge>
                </button>
              </li>
            );
          })}
          {rows.length <= 1 && <li className="px-2 text-xs text-muted-foreground">{a.noTranslations}</li>}
        </ul>
      )}
      {available.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-8" disabled={pending !== null}>
              {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
              {a.addTranslation}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {available.map((locale) => (
              <DropdownMenuItem key={locale} onSelect={() => void add(locale)}>
                {languageName(locale)}
                <span className="ml-auto pl-3 font-mono text-[10px] uppercase text-muted-foreground">{locale}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
