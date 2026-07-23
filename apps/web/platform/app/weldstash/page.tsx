import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Link } from '@/lib/router';
import { Package, Truck, Warehouse, Boxes, Plus } from 'lucide-react';
import {
  useWeldstashProducts,
  useWeldstashSuppliers,
  useWeldstashWarehouses,
  useWeldstashStock,
} from '@/hooks/queries/use-weldstash-queries';
import { getTranslations } from '@/lib/i18n';

function StatCard({ label, value, icon: Icon, href }: { label: string; value: string | number; icon: typeof Package; href: string }) {
  return (
    <Link href={href}>
      <Card className="hover:bg-accent/40 transition-colors">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{value}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function WeldStashDashboard() {
  const t = getTranslations('common');
  const products = useWeldstashProducts({ limit: 1 });
  const suppliers = useWeldstashSuppliers({ limit: 1 });
  const warehouses = useWeldstashWarehouses({ limit: 1 });
  const stock = useWeldstashStock({ limit: 1, lowStockOnly: true });

  return (
    <div className="container mx-auto max-w-[1600px] p-6 space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t.weldstash.dashboard.statProducts} value={products.data?.pagination.totalCount ?? '—'} icon={Package} href="/weldstash/products" />
        <StatCard label={t.weldstash.dashboard.statSuppliers} value={suppliers.data?.pagination.totalCount ?? '—'} icon={Truck} href="/weldstash/suppliers" />
        <StatCard label={t.weldstash.dashboard.statWarehouses} value={warehouses.data?.pagination.totalCount ?? '—'} icon={Warehouse} href="/weldstash/warehouses" />
        <StatCard label={t.weldstash.dashboard.statLowStock} value={stock.data?.pagination.totalCount ?? '—'} icon={Boxes} href="/weldstash/stock?lowStockOnly=true" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.weldstash.dashboard.quickActions}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/weldstash/products"><Button variant="outline"><Plus className="mr-2 h-4 w-4" /> {t.weldstash.dashboard.newProduct}</Button></Link>
          <Link href="/weldstash/suppliers"><Button variant="outline"><Plus className="mr-2 h-4 w-4" /> {t.weldstash.dashboard.newSupplier}</Button></Link>
          <Link href="/weldstash/warehouses"><Button variant="outline"><Plus className="mr-2 h-4 w-4" /> {t.weldstash.dashboard.newWarehouse}</Button></Link>
          <Link href="/weldstash/stock"><Button variant="outline"><Boxes className="mr-2 h-4 w-4" /> {t.weldstash.dashboard.adjustStock}</Button></Link>
        </CardContent>
      </Card>
    </div>
  );
}
