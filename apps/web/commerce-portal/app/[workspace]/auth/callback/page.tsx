'use client';

import { Suspense, useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

function CallbackInner() {
  const slug = String(useParams().workspace ?? '');
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get('token');

  useEffect(() => {
    if (!token) {
      router.replace(`/${slug}/login`);
      return;
    }
    void (async () => {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, slug }),
      });
      const json = await res.json();
      if (json.data?.needsCompanyPicker) {
        sessionStorage.setItem('cportal_picker', JSON.stringify(json.data));
        router.replace(`/${slug}/choose-company`);
        return;
      }
      router.replace(json.data?.token ? `/${slug}` : `/${slug}/login`);
    })();
  }, [router, slug, token]);

  return <main className="min-h-screen flex items-center justify-center">Signing in…</main>;
}

export default function CallbackPage() {
  return (
    <Suspense fallback={<main className="min-h-screen flex items-center justify-center">Signing in…</main>}>
      <CallbackInner />
    </Suspense>
  );
}
