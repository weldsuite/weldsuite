'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { en } from '@weldsuite/i18n/locales/en';
import { portalGet } from '@/lib/client';

const t = en.commerce.portalApp;

type Invoice = {
  id: string;
  invoiceNumber: string | null;
  status: string | null;
  total: string | null;
  balanceDue: string | null;
  currency: string | null;
  dueDate: string;
};

export default function InvoicesPage() {
  const slug = String(useParams().workspace ?? '');
  const [rows, setRows] = useState<Invoice[]>([]);

  useEffect(() => {
    void portalGet<{ data: Invoice[] }>(slug, '/invoices')
      .then((res) => setRows(res.data ?? []))
      .catch(() => undefined);
  }, [slug]);

  return (
    <main className="p-6 space-y-3">
      <h1 className="text-xl font-semibold">{t.invoices}</h1>
      {rows.length === 0 && <p className="text-muted-foreground">{t.noItems}</p>}
      <ul className="divide-y">
        {rows.map((inv) => (
          <li key={inv.id} className="py-3 flex justify-between gap-4">
            <div>
              <div className="font-medium">{inv.invoiceNumber ?? inv.id}</div>
              <div className="text-sm text-muted-foreground">
                {inv.status} · {t.balanceDue} {inv.balanceDue} {inv.currency}
              </div>
            </div>
            <a
              className="text-sm underline"
              href={`/api/portal/invoices/${inv.id}/pdf?slug=${encodeURIComponent(slug)}`}
              target="_blank"
              rel="noreferrer"
            >
              PDF
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
