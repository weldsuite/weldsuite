import { useId } from 'react';
import { useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Phone, PhoneOff, Video } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

/**
 * An incoming WeldChat call, top right: one slim row with the caller's avatar,
 * their name, the kind of call, and square Decline and Accept buttons. While
 * it rings, a green halo breathes behind Accept (the ringtone is the call
 * context's).
 */
export function IncomingCallToast() {
  const { t } = useI18n();
  const nameId = useId();
  const kindId = useId();
  // Optional: this widget is lazy-loaded, so an HMR re-import can transiently
  // see a null context while the provider holds a stale instance. Render
  // nothing instead of crashing the shell (same pattern as PiPCallWidget).
  const ctx = useWeldChatCallOptional();
  if (!ctx) return null;
  const { incomingCall, acceptIncomingCall, declineCall } = ctx;

  // Rings while the user is in a call or meeting too: accepting then asks to switch.
  if (!incomingCall) return null;

  const isVideo = incomingCall.callType === 'video';
  const CallIcon = isVideo ? Video : Phone;
  const strings = t.weldchat.incomingCall;

  return (
    <div
      role="alertdialog"
      aria-labelledby={nameId}
      aria-describedby={kindId}
      data-testid="incoming-call-toast"
      className="fixed top-4 right-4 z-[60] flex w-80 items-center gap-3 rounded-2xl border bg-background p-3 text-foreground shadow-lg animate-in fade-in-0 slide-in-from-top-2"
    >
      {/* The caller: closer together than the buttons are to them. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Avatar className="size-9 shrink-0">
          {incomingCall.callerAvatar && <AvatarImage src={incomingCall.callerAvatar} />}
          <AvatarFallback className="text-sm font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
            {incomingCall.callerName[0]?.toUpperCase() ?? '?'}
          </AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 gap-1">
          <p id={nameId} className="truncate text-sm leading-none font-medium">
            {incomingCall.callerName}
          </p>
          <p id={kindId} className="truncate text-xs text-muted-foreground">
            {isVideo ? strings.incomingVideo : strings.incomingVoice}
          </p>
        </div>
      </div>
      <Button
        size="icon"
        data-testid="incoming-call-decline"
        aria-label={strings.decline}
        title={strings.decline}
        onClick={declineCall}
        className="size-9 shrink-0 rounded-[13px] bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600/40"
      >
        <PhoneOff />
      </Button>
      <span className="relative shrink-0">
        <span
          aria-hidden="true"
          className="absolute -inset-1 rounded-[16px] bg-green-500/35 motion-safe:animate-[weldchat-call-breathe_1.4s_ease-in-out_infinite]"
        />
        <Button
          size="icon"
          data-testid="incoming-call-accept"
          aria-label={strings.accept}
          title={strings.accept}
          onClick={acceptIncomingCall}
          className="relative size-9 rounded-[13px] bg-green-600 text-white hover:bg-green-700 focus-visible:ring-green-600/40"
        >
          <CallIcon />
        </Button>
      </span>
    </div>
  );
}
