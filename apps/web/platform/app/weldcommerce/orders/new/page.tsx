import { ArrowLeft } from 'lucide-react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { useCommerceSettings } from '@/hooks/queries/use-commerce-orders-queries';
import { Link, useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { OrderForm } from '../components/order-form';

const FALLBACK_CURRENCY = 'EUR';

/**
 * A new manual (sales) order. The currency starts from the workspace default
 * (WeldCommerce settings); a member who may not read the settings gets EUR.
 * Creating opens the new order's panel on the order list.
 */
export default function NewCommerceOrderPage() {
  const t = getTranslations('commerce').orders.form;
  const router = useRouter();
  const permissions = usePermissionsMaybe();
  const canCreate = permissions?.can('orders:create') ?? false;
  const canReadSettings = permissions?.can('commerce_settings:read') ?? false;
  const settings = useCommerceSettings(canReadSettings);

  if (!canCreate) {
    return (
      <div className="p-6">
        <EmptyState title={t.noPermission} />
      </div>
    );
  }
  if (canReadSettings && settings.isLoading) return <PageLoader fullScreen={false} />;

  const defaultCurrency = settings.data?.data.defaultCurrency ?? FALLBACK_CURRENCY;

  return (
    <div className="container mx-auto max-w-[1200px] space-y-6 p-6">
      <div className="space-y-1">
        <Link
          href="/weldcommerce/orders"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t.newTitle}</h1>
        <p className="text-muted-foreground">{t.newDescription}</p>
      </div>
      <OrderForm
        defaultCurrency={defaultCurrency}
        onSaved={(id) => router.push(`/weldcommerce/orders?open=${id}`)}
        onCancel={() => router.push('/weldcommerce/orders')}
      />
    </div>
  );
}
