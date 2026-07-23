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

  return (
    <div data-testid="incoming-call-toast" className="fixed top-4 right-4 z-[60] w-80 bg-background border rounded-xl shadow-2xl p-4 animate-in slide-in-from-top-2">
      <div className="flex items-center gap-3 mb-4">
        <Avatar className="h-12 w-12">
          {incomingCall.callerAvatar && (
            <AvatarImage src={incomingCall.callerAvatar} />
          )}
          <AvatarFallback className="text-lg">
            {incomingCall.callerName[0]?.toUpperCase() ?? '?'}
          </AvatarFallback>
        </Avatar>
        <div>
          <p className="font-semibold">{incomingCall.callerName}</p>
          <p className="text-sm text-muted-foreground">
            {isVideo ? t.weldchat.incomingCall.incomingVideo : t.weldchat.incomingCall.incomingVoice}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-center gap-4">
        <Button
          variant="destructive"
          size="icon"
          className="h-12 w-12 rounded-full"
          data-testid="incoming-call-decline"
          onClick={declineCall}
        >
          <PhoneOff className="h-5 w-5" />
        </Button>
        <Button
          className="h-12 w-12 rounded-full bg-green-600 hover:bg-green-700"
          size="icon"
          data-testid="incoming-call-accept"
          onClick={acceptIncomingCall}
        >
          {isVideo ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
        </Button>
      </div>
    </div>
  );
}
