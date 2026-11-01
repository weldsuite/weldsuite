import { LogIn, X } from 'lucide-react';
import type { WidgetConfigResponse } from '@/lib/api/types';
import { fill, t } from '@/lib/i18n';
import { hostSiteName } from '@/lib/sdk-bridge';
import { AvatarStack, readableOn } from './parts';

/**
 * The widget only chats with users the site signed in (identity verification
 * required) and nobody is: say where to sign in. The SDK's next
 * `identify({ identityToken })` / `boot({ identityToken })` opens the chat.
 */
export function SignInRequired({
  config,
  onClose,
}: Readonly<{ config: WidgetConfigResponse; onClose?: () => void }>) {
  const color = config.branding.primaryColor;
  const onColor = readableOn(color);
  const site = hostSiteName();

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="sign-in-required">
      <div
        className="px-6 pt-6 pb-16"
        style={{ background: `linear-gradient(160deg, ${color} 0%, ${color}e6 60%, ${color}b3 100%)`, color: onColor }}
      >
        <div className="flex items-start justify-between">
          <AvatarStack team={config.team} size={34} ring={color} />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              data-testid="close-button"
              className="rounded-full p-1.5 opacity-80 hover:opacity-100 hover:bg-white/15 transition"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
        <p className="mt-8 text-[26px] font-semibold leading-tight tracking-tight text-balance">{config.greeting}</p>
      </div>

      <div className="-mt-10 px-4 pb-4">
        <div className="flex gap-3 rounded-2xl border border-gray-100 bg-white p-4 shadow-[0_2px_12px_rgba(0,0,0,0.08)]">
          <LogIn className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color }} aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">{t.signIn.title}</p>
            <p className="mt-0.5 text-xs text-gray-600">
              {site ? fill(t.signIn.message, { site }) : t.signIn.messageNoSite}
            </p>
            <p className="mt-1 text-xs text-gray-500">{t.signIn.hint}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
