import { Suspense } from 'react'
import { Link } from '@tanstack/react-router'
import { useLazyI18n } from '@weldsuite/i18n/lazy-provider'
import { localeConfig } from '@weldsuite/i18n/locales'
import type { ArticleVersion } from '@/lib/api-client'
import { useSelfServiceStrings } from '@/lib/portal-i18n'

/** A version's language in the reader's UI language (`nl` → "Nederlands" or "Dutch"). */
export function languageName(locale: string, uiLocale: string): string {
  try {
    const name = new Intl.DisplayNames([uiLocale], { type: 'language' }).of(locale)
    if (name && name.toLowerCase() !== locale.toLowerCase()) return name.charAt(0).toLocaleUpperCase(uiLocale) + name.slice(1)
  } catch {
    // Not a tag Intl knows: show the code.
  }
  return locale.toUpperCase()
}

function Languages({ versions, currentSlug }: Readonly<{ versions: ArticleVersion[]; currentSlug: string }>) {
  const t = useSelfServiceStrings()
  const { language } = useLazyI18n()
  const uiLocale = localeConfig[language]?.intlLocale ?? 'en-US'
  const others = versions.filter((v) => v.slug !== currentSlug)
  if (others.length === 0) return null

  return (
    <nav aria-label={t.otherLanguages} className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">{t.otherLanguages}:</span>
      {others.map((version) => (
        <Link
          key={version.slug}
          to="/articles/$slug"
          params={{ slug: version.slug }}
          hrefLang={version.locale ?? undefined}
          lang={version.locale ?? undefined}
          className="rounded-md px-1.5 py-0.5 font-medium text-[var(--hc-accent)] hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          {version.locale ? languageName(version.locale, uiLocale) : t.defaultLanguage}
        </Link>
      ))}
    </nav>
  )
}

/** "Also available in …": links to the article's other language versions. */
export function ArticleLanguages(props: Readonly<{ versions: ArticleVersion[]; currentSlug: string }>) {
  if (props.versions.filter((v) => v.slug !== props.currentSlug).length === 0) return null
  return (
    <Suspense fallback={null}>
      <Languages {...props} />
    </Suspense>
  )
}
