import { useRouterState } from '@tanstack/react-router'
import { AlertIcon, errorMessage, SectionRenderer, useShop } from '@weldsuite/storefront-theme'
import type { TemplatePage } from '@/lib/payload'
import { PageData } from './shop-root'

/**
 * `?error=CODE`: what a server function reports when a form was posted
 * without page script (and what Mollie's return carries after a failed retry).
 */
export function QueryError() {
  const { shop } = useShop()
  const code = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>).error
      return typeof value === 'string' && /^[A-Z_]{2,60}$/.test(value) ? value : null
    },
  })
  if (!code) return null
  return (
    <div role="alert" className="shop-alert">
      <AlertIcon className="mt-0.5 size-5 shrink-0 text-[var(--shop-danger)]" />
      <p>{errorMessage(shop.strings, code)}</p>
    </div>
  )
}

/** A page drawn from its template's sections, with its own data. */
export function TemplateView({ page }: Readonly<{ page: TemplatePage }>) {
  return (
    <PageData data={page.data}>
      <div className="shop-container empty:hidden pt-6">
        <QueryError />
      </div>
      <SectionRenderer sections={page.sections} list={page.template} firstHeadingLevel={page.template === 'home' ? 1 : 2} priorityFirst />
    </PageData>
  )
}
