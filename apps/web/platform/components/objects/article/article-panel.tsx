import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { useArticle } from '@/hooks/queries/use-helpdesk-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  BadgeRow,
  SectionHeader,
  ProseBlock,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';

interface ArticleRecord {
  id: string;
  title: string;
  slug: string | null;
  excerpt: string | null;
  category?: string | null;
  categoryName?: string | null;
  status?: string | null;
  visibility?: string | null;
  authorName?: string | null;
  viewCount?: number | null;
  helpfulCount?: number | null;
  notHelpfulCount?: number | null;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  keywords?: string[] | null;
}

export function ArticlePanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id } = props;
  const { data, isLoading, error } = useArticle(id);
  const article = (data?.data ?? null) as ArticleRecord | null;

  const title = article?.title ?? t('sweep.entities.articleFallbackTitle');
  const subtitle = article?.categoryName ?? article?.category ?? undefined;

  return (
    <SimpleObjectPanel
      {...props}
      objectType="article"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!article}
      title={article ? title : undefined}
      subtitle={subtitle ?? undefined}
      openHref={article ? `/welddesk/knowledge/${article.id}` : undefined}
      statusBadges={article && (
        <>
          {article.status && <Badge variant="outline" className="capitalize">{article.status}</Badge>}
          {article.visibility && (
            <Badge variant="outline" className="capitalize">{article.visibility}</Badge>
          )}
        </>
      )}
      fields={
        article
          ? [
              { label: t('sweep.entities.fieldSlug'), value: article.slug },
              { label: t('sweep.entities.fieldCategory'), value: article.categoryName ?? article.category },
              { label: t('sweep.entities.fieldAuthor'), value: article.authorName },
              { label: t('sweep.entities.fieldViews'), value: article.viewCount?.toString() },
              {
                label: t('sweep.entities.fieldHelpful'),
                value:
                  article.helpfulCount !== null && article.helpfulCount !== undefined
                    ? `${article.helpfulCount} 👍 / ${article.notHelpfulCount ?? 0} 👎`
                    : null,
              },
              { label: t('sweep.entities.fieldPublished'), value: formatPanelDate(article.publishedAt) },
              { label: t('sweep.entities.fieldCreated'), value: formatPanelDate(article.createdAt) },
              { label: t('sweep.entities.fieldUpdated'), value: formatPanelDate(article.updatedAt) },
            ]
          : undefined
      }
      extras={
        article && (
          <>
            {article.excerpt && (
              <>
                <SectionHeader>{t('sweep.entities.excerpt')}</SectionHeader>
                <ProseBlock>{article.excerpt}</ProseBlock>
              </>
            )}
            {article.keywords && article.keywords.length > 0 && (
              <BadgeRow values={article.keywords} />
            )}
          </>
        )
      }
    />
  );
}
