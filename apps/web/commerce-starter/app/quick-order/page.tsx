import type { Metadata } from 'next';
import Link from 'next/link';

import { QuickOrderForm } from '@/components/account-forms';
import { getChannel, getShopper } from '@/lib/data';

export const metadata: Metadata = { title: 'Quick order' };

export default async function QuickOrderPage() {
  const [channel, shopper] = await Promise.all([getChannel(), getShopper()]);
  const signInFirst = channel.audience === 'b2b' && !shopper;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Quick order</h1>
        <p className="text-ink-muted">Know what you need? Add it to your cart by SKU, in one go.</p>
      </div>
      {signInFirst ? (
        <p>
          <Link href="/account/sign-in?next=/quick-order" className="btn btn-primary">
            Sign in to order
          </Link>
        </p>
      ) : (
        <QuickOrderForm />
      )}
    </div>
  );
}
