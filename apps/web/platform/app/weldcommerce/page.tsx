import { Link } from '@/lib/router';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Package, FolderTree, ShoppingCart, Building2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import {
  useCommerceProducts,
  useCommerceCategories,
  useCommerceOrders,
} from '@/hooks/queries/use-commerce-queries';
import { useCompanies } from '@/components/objects/company/use-company-data';
import { usePeople } from '@/components/objects/person/use-person-data';

/**
 * Counts come from each list endpoint's `pagination.totalCount` — the
 * WeldCommerce plan deliberately rejected denormalised counters, so this is
 * the only honest source. `limit: 1` keeps the payload small since we throw
 * the rows away.
 *
 * "Customers" spans two objects: the customers page lists companies AND people,
 * so the stat has to sum both or it undercounts every workspace with person
 * customers — and the number here would disagree with the list it links to.
 */
function useCounts() {
  const products = useCommerceProducts({ limit: 1 });
  const categories = useCommerceCategories({ limit: 1 });
  const orders = useCommerceOrders({ limit: 1 });
  const companies = useCompanies({ limit: 1 });
  const people = usePeople({ limit: 1 });

  const companyCount = companies.data?.pagination?.totalCount;
  const peopleCount = people.data?.pagination?.totalCount;

  return {
    products: products.data?.pagination?.totalCount,
    categories: categories.data?.pagination?.totalCount,
    orders: orders.data?.pagination?.totalCount,
    // Undefined until BOTH have loaded — showing a companies-only subtotal that
    // then jumps would read as a wrong number rather than a loading one.
    customers:
      companyCount != null && peopleCount != null ? companyCount + peopleCount : undefined,
    isLoading:
      products.isLoading ||
      categories.isLoading ||
      orders.isLoading ||
      companies.isLoading ||
      people.isLoading,
  };
}

function StatCard({
  href,
  label,
  count,
  isLoading,
  icon: Icon,
}: {
  href: string;
  label: string;
  count: number | undefined;
  isLoading: boolean;
  icon: typeof Package;
}) {
  return (
    <Link href={href} className="block">
      <Card className="transition-colors hover:border-primary/50">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">
            {isLoading ? <span className="text-muted-foreground">—</span> : count ?? 0}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function WeldCommerceOverviewPage() {
  const t = getTranslations('commerce').module;
  const counts = useCounts();

  return (
    <div className="container mx-auto max-w-[1600px] p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t.overview.heading}</h2>
        <p className="text-sm text-muted-foreground">{t.overview.subtitle}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          href="/weldcommerce/products"
          label={t.tabs.products}
          count={counts.products}
          isLoading={counts.isLoading}
          icon={Package}
        />
        <StatCard
          href="/weldcommerce/categories"
          label={t.tabs.categories}
          count={counts.categories}
          isLoading={counts.isLoading}
          icon={FolderTree}
        />
        <StatCard
          href="/weldcommerce/orders"
          label={t.tabs.orders}
          count={counts.orders}
          isLoading={counts.isLoading}
          icon={ShoppingCart}
        />
        <StatCard
          href="/weldcommerce/customers"
          label={t.tabs.customers}
          count={counts.customers}
          isLoading={counts.isLoading}
          icon={Building2}
        />
      </div>
    </div>
  );
}
