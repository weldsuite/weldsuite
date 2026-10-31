import { useState } from 'react';
import { Loader2, Mail } from 'lucide-react';
import type { Messenger } from '@/hooks/use-messenger';
import { cn } from '@/lib/utils/cn';
import { t } from '@/lib/i18n';
import { readableOn } from './parts';

interface EmailCaptureProps {
  messenger: Messenger;
  color: string;
  /** Outside office hours: ask for the email as the way we'll reply. */
  away?: boolean;
  className?: string;
}

/** Ask for the visitor's email so a reply reaches them after they leave; once given, say where it goes. */
export function EmailCapture({ messenger, color, away = false, className = 'mx-4 my-2' }: Readonly<EmailCaptureProps>) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');

  // The site vouched for this visitor without an email: a typed one wouldn't be kept.
  if (messenger.verified && !messenger.profile.email) return null;

  if (messenger.profile.email) {
    return (
      <div className={cn('flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-600', className)}>
        <Mail className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate">
          You&apos;ll be notified at <span className="font-medium text-gray-900">{messenger.profile.email}</span>
        </span>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)) {
      setState('error');
      return;
    }
    setState('saving');
    try {
      await messenger.identify(value);
      setState('idle');
    } catch {
      setState('error');
    }
  };

  return (
    <form
      onSubmit={submit}
      className={cn('rounded-2xl border border-gray-200 bg-white p-3.5 shadow-sm', className)}
      data-testid="email-capture"
    >
      <p className="text-[13px] font-semibold text-gray-900">{away ? t.away.emailTitle : 'Get notified by email'}</p>
      <p className="text-xs text-gray-500 mt-0.5">
        {away ? t.away.emailHint : "We'll email you when we reply, in case you've left."}
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <input
          type="email"
          name="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state === 'error') setState('idle');
          }}
          placeholder="you@example.com"
          className={cn(
            'min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:outline-none focus:border-gray-400',
            state === 'error' ? 'border-red-400' : 'border-gray-200',
          )}
        />
        <button
          type="submit"
          disabled={state === 'saving'}
          className="rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-60"
          style={{ backgroundColor: color, color: readableOn(color) }}
        >
          {state === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </button>
      </div>
      {state === 'error' && <p className="mt-1.5 text-xs text-red-500">Please enter a valid email address.</p>}
    </form>
  );
}
