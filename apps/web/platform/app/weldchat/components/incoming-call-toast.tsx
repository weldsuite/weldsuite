import { useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Phone, PhoneOff, Video } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

export function IncomingCallToast() {
  const { t } = useI18n();
  // Optional: this widget is lazy-loaded, so an HMR re-import can transiently
  // see a null context while the provider holds a stale instance. Render
  // nothing instead of crashing the shell (same pattern as PiPCallWidget).
  const ctx = useWeldChatCallOptional();
  if (!ctx) return null;
  const { incomingCall, status, acceptIncomingCall, declineCall } = ctx;

  if (status !== 'ringing-incoming' || !incomingCall) return null;

  const isVideo = incomingCall.callType === 'video';
  const CallIcon = isVideo ? Video : Phone;

  return (
    <div
      data-testid="incoming-call-toast"
      className="fixed top-4 right-4 z-[60] w-80 rounded-lg border bg-background p-4 text-foreground shadow-lg animate-in fade-in-0 slide-in-from-top-2"
    >
      <div className="flex items-center gap-3">
        <Avatar className="size-10 !rounded-[12px]">
          {incomingCall.callerAvatar && (
            <AvatarImage src={incomingCall.callerAvatar} className="!rounded-[12px]" />
          )}
          <AvatarFallback className="!rounded-[12px] text-sm font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
            {incomingCall.callerName[0]?.toUpperCase() ?? '?'}
          </AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="truncate text-sm leading-none font-medium">{incomingCall.callerName}</p>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CallIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {isVideo ? t.weldchat.incomingCall.incomingVideo : t.weldchat.incomingCall.incomingVoice}
            </span>
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button
          variant="destructive"
          size="sm"
          data-testid="incoming-call-decline"
          onClick={declineCall}
        >
          <PhoneOff />
          {t.weldchat.incomingCall.decline}
        </Button>
        <Button
          size="sm"
          className="bg-green-600 text-white hover:bg-green-700"
          data-testid="incoming-call-accept"
          onClick={acceptIncomingCall}
        >
          <CallIcon />
          {t.weldchat.incomingCall.accept}
        </Button>
      </div>
    </div>
  );
}
