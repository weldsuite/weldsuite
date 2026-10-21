/**
 * The short goodbye after a WeldChat call (status `ended`): "You left the
 * call" / "Call ended" with how long it lasted. It fades in where the room
 * was and fades out just before the call view closes, so leaving is not an
 * abrupt cut back to the chat.
 */

import { useEffect, useState } from 'react';
import { PhoneOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { CALL_ENDED_VISIBLE_MS, useWeldChatCall } from '@/contexts/weldchat-call-context';

const FADE_OUT_MS = 300;

function formatCallDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function CallEndedView() {
  const { t } = useI18n();
  const { endReason, duration } = useWeldChatCall();
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setFading(true), CALL_ENDED_VISIBLE_MS - FADE_OUT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={cn(
        'flex-1 flex items-center justify-center bg-background transition-opacity duration-300',
        fading && 'opacity-0',
      )}
    >
      <div className="flex flex-col items-center gap-3 animate-in fade-in zoom-in-95 duration-300">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <PhoneOff className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-[16px] font-medium text-foreground">
          {endReason === 'left' ? t.weldchat.calling.youLeft : t.weldchat.callRoom.callEnded}
        </p>
        {duration > 0 && (
          <p className="text-sm tabular-nums text-muted-foreground">{formatCallDuration(duration)}</p>
        )}
      </div>
    </div>
  );
}
