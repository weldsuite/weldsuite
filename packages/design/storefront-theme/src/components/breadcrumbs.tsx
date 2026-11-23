import { useShop } from '../context';
import { ShopLink } from './shop-link';

export interface Crumb {
  label: string;
  href: string;
}

/** Where the page sits: Home › Category › Product. The last crumb is the page itself. */
export function Breadcrumbs({ trail }: Readonly<{ trail: Crumb[] }>) {
  const { shop } = useShop();
  if (trail.length < 2) return null;
  return (
    <nav aria-label={shop.strings.common.breadcrumb} className="text-sm">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={`${crumb.href}-${index}`} className="flex items-center gap-2">
              {last ? (
                <span aria-current="page" className="text-shop-subtle">
                  {crumb.label}
                </span>
              ) : (
                <>
                  <ShopLink href={crumb.href} className="underline underline-offset-4">
                    {crumb.label}
                  </ShopLink>
                  <span aria-hidden="true" className="text-shop-subtle">
                    /
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
