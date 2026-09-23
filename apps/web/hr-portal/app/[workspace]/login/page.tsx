'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { usePortalConfig } from '@/lib/hooks/use-portal-config';
import { useBranding } from '@/lib/hooks/use-branding';
import { Button, Input, Label } from '@/components/ui/primitives';
import { LoadingState } from '@/components/ui/states';
import { PortalNotAvailable } from '@/components/portal-not-available';
import { PortalLogo } from '@/components/portal-logo';
import type { PortalPickerOption } from '@/lib/types';

const RESEND_SECONDS = 30;

type Step = 'email' | 'code' | 'picker';

export default function LoginPage() {
  const slug = String(useParams().workspace ?? '');
  const router = useRouter();
  const { dict, format } = useI18n();
  const { config, status } = usePortalConfig(slug);
  useBranding(config);

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [pickerToken, setPickerToken] = useState('');
  const [options, setOptions] = useState<PortalPickerOption[]>([]);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (step !== 'code' || resendIn <= 0) return;
    const timer = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [step, resendIn]);

  useEffect(() => {
    if (step === 'code') codeInputRef.current?.focus();
  }, [step]);

  function redirectFor(kind: 'employee' | 'client') {
    router.push(kind === 'employee' ? `/${slug}/me` : `/${slug}/client`);
  }

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, slug }),
      });
      setStep('code');
      setResendIn(RESEND_SECONDS);
    } catch {
      setError(dict.login.genericError);
    } finally {
      setBusy(false);
    }
  }

  function requestCode(e: FormEvent) {
    e.preventDefault();
    void sendCode();
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp, slug }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: { session?: { kind: 'employee' | 'client' }; pickerToken?: string; options?: PortalPickerOption[] };
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(json.error?.message || dict.login.genericError);
        return;
      }
      if (json.data?.pickerToken) {
        setPickerToken(json.data.pickerToken);
        setOptions(json.data.options ?? []);
        setStep('picker');
        return;
      }
      if (json.data?.session) {
        redirectFor(json.data.session.kind);
        return;
      }
      setError(dict.login.genericError);
    } catch {
      setError(dict.login.genericError);
    } finally {
      setBusy(false);
    }
  }

  async function choose(accessId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickerToken, accessId, slug }),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { session?: { kind: 'employee' | 'client' } }; error?: { message?: string } };
      if (!res.ok || !json.data?.session) {
        setError(json.error?.message || dict.login.genericError);
        return;
      }
      redirectFor(json.data.session.kind);
    } catch {
      setError(dict.login.genericError);
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading') {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <LoadingState />
      </main>
    );
  }
  if (status === 'not_found' || status === 'error' || !config) {
    return <PortalNotAvailable />;
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <PortalLogo config={config} size={48} />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">{config.displayName}</h1>
            {config.welcomeMessage && <p className="text-sm text-gray-500 mt-1">{config.welcomeMessage}</p>}
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-6 space-y-5">
          {step === 'email' && (
            <form onSubmit={requestCode} className="space-y-4">
              <div>
                <h2 className="text-base font-medium text-gray-900">{dict.login.title}</h2>
                <p className="text-sm text-gray-500 mt-1">{dict.login.subtitle}</p>
              </div>
              <div>
                <Label htmlFor="email">{dict.login.emailLabel}</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  placeholder={dict.login.emailPlaceholder}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" disabled={busy || !email} className="w-full">
                {dict.login.sendCode}
              </Button>
            </form>
          )}

          {step === 'code' && (
            <form onSubmit={verifyCode} className="space-y-4">
              <p className="text-sm text-gray-500">{dict.login.checkEmail}</p>
              <div>
                <Label htmlFor="otp">{dict.login.codeLabel}</Label>
                <Input
                  id="otp"
                  ref={codeInputRef}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder={dict.login.codePlaceholder}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                  className="tracking-[0.4em] text-center text-lg"
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" disabled={busy || otp.length < 4} className="w-full">
                {dict.login.verify}
              </Button>
              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  className="text-gray-500 underline underline-offset-2"
                  onClick={() => {
                    setStep('email');
                    setOtp('');
                    setError(null);
                  }}
                >
                  {dict.login.changeEmail}
                </button>
                {resendIn > 0 ? (
                  <span className="text-gray-400">{format(dict.login.resendIn, { seconds: resendIn })}</span>
                ) : (
                  <button type="button" className="portal-link underline underline-offset-2" onClick={() => void sendCode()}>
                    {dict.login.resend}
                  </button>
                )}
              </div>
            </form>
          )}

          {step === 'picker' && (
            <div className="space-y-3">
              <h2 className="text-base font-medium text-gray-900">{dict.login.pickerTitle}</h2>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <ul className="space-y-2">
                {options.map((opt) => (
                  <li key={opt.accessId}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void choose(opt.accessId)}
                      className="w-full rounded-md border border-gray-300 px-4 py-3 text-left text-sm hover:bg-gray-50 disabled:opacity-50"
                    >
                      {opt.kind === 'employee'
                        ? dict.login.continueAsEmployee
                        : format(dict.login.continueAsClientAt, { company: opt.companyName || opt.displayName || '' })}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {!config.hideWeldsuiteBranding && <p className="text-center text-xs text-gray-400">{dict.common.poweredBy}</p>}
      </div>
    </main>
  );
}
