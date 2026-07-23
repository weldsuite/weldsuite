import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getArticles, getFolders } from '@/lib/api-client'
import { Breadcrumbs } from '@/components/Breadcrumbs'

export async function generateMetadata({ params }: { params: Promise<{ domain: string; id: string }> }) {
  const { domain, id } = await params
  const folders = await getFolders(domain)
  const folder = folders.find((f) => f.id === id)
  if (!folder) return { title: 'Category Not Found' }
  return { title: folder.name }
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ domain: string; id: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { domain, id } = await params
  const { page } = await searchParams
  const [folders, articles] = await Promise.all([
    getFolders(domain),
    getArticles(domain, { folderId: id, page: page || '1' }),
  ])

  const folder = folders.find((f) => f.id === id)
  if (!folder) notFound()

  return (
    <div className="max-w-3xl py-10 lg:py-14">
      <Breadcrumbs folder={folder} />
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">
        {folder.name}
      </h1>
      {folder.description && (
        <p className="mt-2 text-zinc-500 dark:text-zinc-400">{folder.description}</p>
      )}

      {articles.data.length === 0 ? (
        <p className="mt-10 text-zinc-500 dark:text-zinc-400">No articles in this category yet.</p>
      ) : (
        <div className="mt-8 divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {articles.data.map((article) => (
            <Link
              key={article.id}
              href={`/articles/${article.slug}`}
              className="group flex items-start gap-4 py-4 transition-colors"
            >
              <span className="min-w-0 flex-auto">
                <span className="block font-medium text-zinc-900 group-hover:text-[var(--hc-accent)] dark:text-white">
                  {article.title}
                </span>
                {article.excerpt && (
                  <span className="mt-1 line-clamp-2 block text-sm text-zinc-500 dark:text-zinc-400">
                    {article.excerpt}
                  </span>
                )}
              </span>
              <svg
                className="mt-1 h-4 w-4 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--hc-accent)] dark:text-zinc-600"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          ))}
        </div>
      )}

      {articles.pagination.totalPages > 1 && (
        <div className="mt-10 flex justify-center gap-1.5">
          {Array.from({ length: articles.pagination.totalPages }, (_, i) => i + 1).map((p) => (
            <Link
              key={p}
              href={`/category/${id}?page=${p}`}
              className={
                p === articles.pagination.page
                  ? 'rounded-lg bg-[var(--hc-accent)] px-3 py-1.5 text-sm font-medium text-white'
                  : 'rounded-lg px-3 py-1.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }
            >
              {p}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
