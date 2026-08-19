'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { en } from '@weldsuite/i18n/locales/en';
import { portalGet } from '@/lib/client';

const t = en.commerce.portalApp;

type Me = {
  person: { displayName: string | null; email: string | null };
  company: { displayName: string | null };
  party: { paymentTerms: string | null; creditLimit: unknown; outstandingBalance: string | null; currency: string | null } | null;
};

export default function AccountPage() {
  const slug = String(useParams().workspace ?? '');
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    void portalGet<{ data: Me }>(slug, '/me')
      .then((res) => setMe(res.data))
      .catch(() => undefined);
  }, [slug]);

  if (!me) return <main className="p-6">{t.noItems}</main>;

  return (
    <main className="p-6 space-y-2 max-w-lg">
      <h1 className="text-xl font-semibold">{t.account}</h1>
      <p>{me.person.displayName}</p>
      <p className="text-sm text-muted-foreground">{me.person.email}</p>
      <p className="pt-2 font-medium">{me.company.displayName}</p>
      {me.party?.paymentTerms && (
        <p className="text-sm">
          {t.paymentTerms}: {me.party.paymentTerms}
        </p>
      )}
      {me.party?.outstandingBalance != null && (
        <p className="text-sm">
          {t.balanceDue}: {me.party.outstandingBalance} {me.party.currency}
        </p>
      )}
    </main>
  );
}
