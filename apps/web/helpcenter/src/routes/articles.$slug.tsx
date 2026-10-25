import { createFileRoute } from '@tanstack/react-router'
import { getArticlePage } from '@/lib/api-client'
import { pageTitle, useSite } from '@/lib/site'
import { ArticleContent } from '@/components/ArticleContent'
import { ArticleFeedback } from '@/components/ArticleFeedback'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { TableOfContents } from '@/components/TableOfContents'

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
        <article>
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
