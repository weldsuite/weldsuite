
import { ShoppingCart, Plus, Package, Truck, CheckCircle, XCircle, Clock, MoreHorizontal } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import type { OrdersSectionProps, CustomerOrder } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

const statusConfig: Record<string, { icon: typeof Package; color: string; bg: string }> = {
  pending: { icon: Clock, color: 'text-yellow-600', bg: 'bg-yellow-100' },
  processing: { icon: Package, color: 'text-blue-600', bg: 'bg-blue-100' },
  shipped: { icon: Truck, color: 'text-purple-600', bg: 'bg-purple-100' },
  delivered: { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-100' },
  completed: { icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-100' },
  cancelled: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-100' },
};

function formatCurrency(amount: string | number, currency = 'USD'): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(num);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function OrdersSection({ customer, orders, totalCount }: OrdersSectionProps) {
  const t = useTranslations();
  // Calculate totals
  const totalValue = orders.reduce((sum, order) => sum + parseFloat(order.total || '0'), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-medium text-foreground">{t('sweep.weldcrm.ordersSection.orders')}</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.ordersSection.orderCount', { count: totalCount })}</span>
          <Button size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('sweep.weldcrm.ordersSection.newOrder')}
          </Button>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="text-center py-12">
          <ShoppingCart className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">{t('sweep.weldcrm.ordersSection.noOrdersYet')}</h3>
          <p className="text-sm text-muted-foreground mb-4">{t('sweep.weldcrm.ordersSection.noOrdersYetDescription')}</p>
          <Button className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t('sweep.weldcrm.ordersSection.createOrder')}
          </Button>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-background border border-border rounded-lg p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('sweep.weldcrm.ordersSection.totalOrders')}</p>
              <p className="text-2xl font-semibold text-foreground">{totalCount}</p>
            </div>
            <div className="bg-background border border-border rounded-lg p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('sweep.weldcrm.ordersSection.totalValue')}</p>
              <p className="text-2xl font-semibold text-foreground">
                {formatCurrency(totalValue)}
              </p>
            </div>
            <div className="bg-background border border-border rounded-lg p-4">
              <p className="text-sm text-muted-foreground mb-1">{t('sweep.weldcrm.ordersSection.avgOrderValue')}</p>
              <p className="text-2xl font-semibold text-foreground">
                {formatCurrency(totalValue / orders.length)}
              </p>
            </div>
          </div>

          {/* Orders List */}
          <div className="space-y-2">
            {orders.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OrderCard({ order }: { order: CustomerOrder }) {
  const t = useTranslations();
  const status = order.status || 'pending';
  const config = statusConfig[status] || statusConfig.pending;
  const IconComponent = config.icon;

  return (
    <div className="flex items-center gap-4 p-4 bg-background border border-border rounded-lg hover:border-border transition-colors group">
      <div className={cn("p-2 rounded-lg", config.bg)}>
        <IconComponent className={cn("h-5 w-5", config.color)} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">
            #{order.orderNumber}
          </span>
          <span className={cn(
            "text-xs px-2 py-0.5 rounded-full",
            config.bg,
            config.color
          )}>
            {status}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
          <span>{formatDate(order.createdAt)}</span>
          <span>·</span>
          <span>{order.itemCount} items</span>
          {order.source && (
            <>
              <span>·</span>
              <span className="capitalize">{order.source}</span>
            </>
          )}
        </div>
      </div>

      <div className="text-right">
        <p className="font-medium text-foreground">
          {formatCurrency(order.total, order.currency)}
        </p>
        {order.paymentStatus && (
          <p className={cn(
            "text-xs",
            order.paymentStatus === 'paid' ? 'text-green-600' :
            order.paymentStatus === 'refunded' ? 'text-red-600' :
            'text-muted-foreground'
          )}>
            {order.paymentStatus}
          </p>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem>{t('sweep.weldcrm.ordersSection.viewOrder')}</DropdownMenuItem>
          <DropdownMenuItem>{t('sweep.weldcrm.ordersSection.editOrder')}</DropdownMenuItem>
          <DropdownMenuItem>{t('sweep.weldcrm.ordersSection.trackShipment')}</DropdownMenuItem>
          <DropdownMenuItem>{t('sweep.weldcrm.ordersSection.createInvoice')}</DropdownMenuItem>
          <DropdownMenuItem className="text-red-600">{t('sweep.weldcrm.ordersSection.cancelOrder')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
