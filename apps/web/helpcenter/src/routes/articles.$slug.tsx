import { createFileRoute } from '@tanstack/react-router'
import { getArticlePage, type ArticleVersion, type SiteData } from '@/lib/api-client'
import { pageTitle, useSite } from '@/lib/site'
import { ArticleContent } from '@/components/ArticleContent'
import { ArticleFeedback } from '@/components/ArticleFeedback'
import { ArticleLanguages } from '@/components/ArticleLanguages'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { TableOfContents } from '@/components/TableOfContents'

/**
 * `<link rel="alternate" hreflang>` for each language version, so search
 * engines show readers the version in their language. The help center's
 * default language (a null locale) is `x-default`. Only when there is more
 * than one version.
 */
function alternateLinks(
  versions: ArticleVersion[],
  matches: ReadonlyArray<{ routeId: string; loaderData?: unknown }>,
) {
  if (versions.length < 2) return []
  const site = matches.find((m) => m.routeId === '__root__')?.loaderData as SiteData | undefined
  if (!site?.domain) return []
  return versions.map((version) => ({
    rel: 'alternate',
    hrefLang: version.locale ?? 'x-default',
    href: `https://${site.domain}/articles/${encodeURIComponent(version.slug)}`,
  }))
}

export const Route = createFileRoute('/articles/$slug')({
  loader: ({ params }) => getArticlePage({ data: { slug: params.slug } }),
  head: ({ loaderData, matches }) => ({
    meta: loaderData
      ? [
          { title: pageTitle(matches, loaderData.article.title) },
          ...(loaderData.article.excerpt
            ? [{ name: 'description', content: loaderData.article.excerpt }]
            : []),
        ]
      : [{ title: 'Article Not Found' }],
    links: loaderData ? alternateLinks(loaderData.article.versions ?? [], matches) : [],
  }),
  component: ArticlePage,
})

function ArticlePage() {
  const { article, headings } = Route.useLoaderData()
  const { folders } = useSite()
  const folder = folders.find((f) => f.id === article.folderId)

  return (
    <div className="flex gap-12 py-10 lg:py-14">
      <div className="min-w-0 max-w-3xl flex-auto">
        <article lang={article.locale ?? undefined}>
          <Breadcrumbs folder={folder} articleTitle={article.title} />

          {article.updatedAt && (
            <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
              Last updated{' '}
              {new Date(article.updatedAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
          )}

          <ArticleLanguages versions={article.versions ?? []} currentSlug={article.slug} />

          <ArticleContent html={article.content || ''} />
        </article>

        <div className="mt-14 border-t border-zinc-200 pt-8 dark:border-zinc-800">
          <ArticleFeedback articleId={article.id} />
        </div>
      </div>

      <TableOfContents headings={headings} />
    </div>
  )
}
