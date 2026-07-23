import Link from 'next/link'
import { getHelpcenterConfig, getFolders, getArticles } from '@/lib/api-client'
import { SearchBar } from '@/components/SearchBar'
import { CategoryIcon } from '@/components/CategoryIcon'

export default async function HomePage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params
  const [config, folders, recent] = await Promise.all([
    getHelpcenterConfig(domain),
    getFolders(domain),
    getArticles(domain, { pageSize: '6' }),
  ])

  const roots = folders.filter((f) => !f.parentId)
  const popular = roots.slice(0, 4)

  return (
    <div className="px-1 py-14 lg:py-20">
      {/* Hero */}
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl dark:text-white">
          {config?.heroTitle || 'How can we help?'}
        </h1>
        {config?.heroSubtitle && (
          <p className="mx-auto mt-4 max-w-xl text-lg text-zinc-500 dark:text-zinc-400">
            {config.heroSubtitle}
          </p>
        )}
        {config?.showSearch !== 0 && (
          <div className="mx-auto mt-8 max-w-xl">
            <SearchBar size="hero" />
          </div>
        )}
        {popular.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-sm">
            <span className="text-zinc-400">Popular:</span>
            {popular.map((f) => (
              <Link
                key={f.id}
                href={`/category/${f.id}`}
                className="rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:text-white"
              >
                {f.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Category cards */}
      {config?.showCategories !== 0 && roots.length > 0 && (
        <div className="mx-auto mt-16 grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {roots.map((folder) => {
            const count = folder.articleCount ?? 0
            return (
              <Link
                key={folder.id}
                href={`/category/${folder.id}`}
                className="group rounded-2xl border border-zinc-200 bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                <CategoryIcon icon={folder.icon} />
                <h3 className="mt-4 font-semibold text-zinc-900 dark:text-white">{folder.name}</h3>
                <p className="mt-1 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">
                  {folder.description || `${count} article${count === 1 ? '' : 's'}`}
                </p>
              </Link>
            )
          })}
        </div>
      )}

      {/* Get started / popular articles */}
      {recent.data.length > 0 && (
        <div className="mx-auto mt-20 grid max-w-4xl gap-8 border-t border-zinc-200 pt-12 lg:grid-cols-[1fr_1.4fr] dark:border-zinc-800">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white">
              Get started
            </h2>
            <p className="mt-2 text-zinc-500 dark:text-zinc-400">
              Popular articles to help you find your way around.
            </p>
          </div>
          <ol className="space-y-0.5">
            {recent.data.map((article, i) => (
              <li key={article.id}>
                <Link
                  href={`/articles/${article.slug}`}
                  className="group flex items-start gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  <span className="mt-0.5 text-sm tabular-nums text-zinc-300 dark:text-zinc-600">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-zinc-900 dark:text-white">{article.title}</span>
                    {article.excerpt && (
                      <span className="mt-0.5 line-clamp-1 block text-sm text-zinc-500 dark:text-zinc-400">
                        {article.excerpt}
                      </span>
                    )}
                  </span>
                  <svg
                    className="ml-auto mt-1 h-4 w-4 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-500 dark:text-zinc-600"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
