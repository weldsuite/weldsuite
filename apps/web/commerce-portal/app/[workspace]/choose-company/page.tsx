'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { en } from '@weldsuite/i18n/locales/en';

const t = en.commerce.portalApp;

type Company = { accessId: string; companyId: string; name: string };

export default function ChooseCompanyPage() {
  const slug = String(useParams().workspace ?? '');
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [pickerToken, setPickerToken] = useState('');

  useEffect(() => {
    const raw = sessionStorage.getItem('cportal_picker');
    if (!raw) {
      router.replace(`/${slug}/login`);
      return;
    }
    const parsed = JSON.parse(raw) as { pickerToken: string; companies: Company[] };
    setPickerToken(parsed.pickerToken);
    setCompanies(parsed.companies ?? []);
  }, [router, slug]);

  async function choose(companyId: string) {
    const res = await fetch('/api/auth/select-company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, pickerToken, companyId }),
    });
    const json = await res.json();
    if (json.data?.token) {
      sessionStorage.removeItem('cportal_picker');
      router.replace(`/${slug}`);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">{t.chooseCompany}</h1>
        <ul className="space-y-2">
          {companies.map((c) => (
            <li key={c.companyId}>
              <button
                type="button"
                className="w-full rounded-md border px-3 py-2 text-left hover:bg-neutral-50"
                onClick={() => void choose(c.companyId)}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
