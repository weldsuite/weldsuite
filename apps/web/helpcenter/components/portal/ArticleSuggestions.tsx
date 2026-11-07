import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { suggestArticles, type ArticleSuggestion } from '@/lib/api-client'
import { useSelfServiceStrings } from '@/lib/portal-i18n'

const DEBOUNCE_MS = 400
const MIN_LENGTH = 3
const MAX_QUERY = 200

/**
 * What to search for while the reader fills in the request form: the title
 * once it says something, else the start of the description. A whole
 * description makes a poor search (every word has to match), the title is
 * usually the question itself.
 */
export function suggestionQuery(title: string, description: string): string {
  const head = title.trim()
  if (head.length >= MIN_LENGTH) return head.slice(0, MAX_QUERY)
  const firstLine = description.trim().split(/\r?\n/, 1)[0] ?? ''
  return firstLine.slice(0, 100).trim()
}

/** Debounced article search for `query`; the latest answer wins. */
function useSuggestions(query: string): ArticleSuggestion[] {
  const [articles, setArticles] = useState<ArticleSuggestion[]>([])
  const latest = useRef(0)

  useEffect(() => {
    const ticket = ++latest.current
    if (query.length < MIN_LENGTH) {
      setArticles([])
      return
    }
    const timer = setTimeout(() => {
      suggestArticles({ data: { q: query } })
        .then((found) => {
          if (ticket === latest.current) setArticles(found)
        })
        .catch(() => {
          // A failed lookup only means no suggestions; the form still works.
          if (ticket === latest.current) setArticles([])
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  return articles
}

/**
 * "These articles might help": up to three articles that match what the
 * reader is typing, before they send the request.
 */
export function ArticleSuggestions({ query }: Readonly<{ query: string }>) {
  const t = useSelfServiceStrings()
  const articles = useSuggestions(query)
  if (articles.length === 0) return null

  return (
    <section
      aria-live="polite"
      aria-labelledby="hc-suggestions-heading"
      className="rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/50"
      data-testid="hc-article-suggestions"
    >
      <h2 id="hc-suggestions-heading" className="text-sm font-semibold text-zinc-900 dark:text-white">
        {t.suggestionsTitle}
      </h2>
      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{t.suggestionsHint}</p>
      <ul className="mt-2 divide-y divide-zinc-200/70 dark:divide-zinc-800">
        {articles.map((article) => (
          <li key={article.id}>
            <Link
              to="/articles/$slug"
              params={{ slug: article.slug }}
              target="_blank"
              className="group block py-2"
            >
              <span className="block text-sm font-medium text-zinc-900 group-hover:text-[var(--hc-accent)] dark:text-white">
                {article.title}
              </span>
              {article.excerpt && (
                <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500 dark:text-zinc-400">{article.excerpt}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
