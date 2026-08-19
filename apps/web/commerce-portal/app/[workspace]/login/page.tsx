'use client';

import { FormEvent, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { en } from '@weldsuite/i18n/locales/en';

const t = en.commerce.portalApp;

export default function LoginPage() {
  const slug = String(useParams().workspace ?? '');
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function requestLink(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, slug }),
      });
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp, slug }),
      });
      const json = await res.json();
      if (json.data?.needsCompanyPicker) {
        sessionStorage.setItem('cportal_picker', JSON.stringify(json.data));
        router.push(`/${slug}/choose-company`);
        return;
      }
      if (json.data?.token) router.push(`/${slug}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-semibold">{t.signIn}</h1>
        <form onSubmit={requestLink} className="space-y-3">
          <label className="block text-sm">
            {t.email}
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-neutral-900 text-white py-2 text-sm"
          >
            {t.sendLink}
          </button>
        </form>
        {sent && <p className="text-sm text-muted-foreground">{t.checkEmail}</p>}
        <form onSubmit={verifyOtp} className="space-y-3">
          <label className="block text-sm">
            {t.code}
            <input
              inputMode="numeric"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2 tracking-widest"
            />
          </label>
          <button type="submit" disabled={busy || otp.length < 4} className="w-full rounded-md border py-2 text-sm">
            {t.verify}
          </button>
        </form>
      </div>
    </main>
  );
}
