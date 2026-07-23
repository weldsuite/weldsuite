import * as React from 'react';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useProviderCallback } from '@/hooks/queries/use-integration-queries';

export default function GoogleCalendarCallbackClient() {
  const router = useRouter();
  const { t } = useI18n();
  const ts = t.settings.integrations.googleCalendar.callback;
  const callbackMutation = useProviderCallback();
  const processed = React.useRef(false);

  React.useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');

    if (!code || !state) {
      toast.error(ts.invalidCallback);
      router.push('/settings/integrations/google-calendar');
      return;
    }

    const redirectUri = `${window.location.origin}/settings/integrations/google-calendar/callback`;

    (async () => {
      try {
        await callbackMutation.mutateAsync({ provider: 'google_calendar', code, state, redirectUri });
        toast.success(ts.success);
        router.push('/settings/integrations/google-calendar');
      } catch (err) {
        console.error('[Google Calendar callback] Error:', err);
        toast.error(err instanceof Error ? err.message : ts.failed);
        router.push('/settings/integrations/google-calendar');
      }
    })();
  }, []);

  return (
    <div className="w-full flex items-center justify-center h-full min-h-[calc(100vh-8rem)] pb-[60px]">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{ts.connecting}</p>
      </div>
    </div>
  );
}
