import Link from 'next/link'
import { searchArticles } from '@/lib/api-client'
import { SearchBar } from '@/components/SearchBar'

export const metadata = { title: 'Search' }

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ domain: string }>
  searchParams: Promise<{ q?: string; page?: string }>
}) {
  const { domain } = await params
  const { q, page } = await searchParams
  const query = q?.trim()
  const results = query ? await searchArticles(domain, query, page || '1') : null

  return (
    <div className="max-w-3xl py-10 lg:py-14">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">Search</h1>

      <div className="mt-6">
        <SearchBar defaultValue={query} autoFocus size="hero" />
      </div>

      {query && results && (
        <div className="mt-10">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {results.pagination.totalCount} result{results.pagination.totalCount !== 1 ? 's' : ''} for{' '}
            <span className="font-medium text-zinc-700 dark:text-zinc-200">&ldquo;{query}&rdquo;</span>
          </p>

          {results.data.length === 0 ? (
            <p className="mt-8 text-zinc-500 dark:text-zinc-400">
              No articles found. Try different keywords.
            </p>
          ) : (
            <div className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {results.data.map((article) => (
                <Link
                  key={article.id}
                  href={`/articles/${article.slug}`}
                  className="group flex items-start gap-4 py-4"
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
        </div>
      )}
    </div>
  )
}
