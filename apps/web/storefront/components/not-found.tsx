import { getRouteApi } from '@tanstack/react-router'
import { SectionRenderer, useOptionalShop } from '@weldsuite/storefront-theme'
import { ShopRoot } from './shop-root'

const root = getRouteApi('__root__')

/**
 * The 404 page: the site's `notFound` template. Inside the shop's layout when
 * a page's loader said "not found"; with the layout drawn here when no route
 * matched at all.
 */
export function NotFoundPage() {
  const payload = root.useLoaderData()
  const inLayout = useOptionalShop() !== null
  const page = <SectionRenderer sections={payload.notFoundSections} list="notFound" priorityFirst />
  if (inLayout) return page
  return <ShopRoot payload={payload}>{page}</ShopRoot>
}
