import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useJoinByCode } from '@/hooks/queries/use-weldmeet-queries';
import { getTranslations } from '@/lib/i18n';

function JoinByCodePage() {
  const { joinCode } = Route.useParams();
  const navigate = useNavigate();
  const { mutate: joinByCode } = useJoinByCode();
  const t = getTranslations('weldmeet');

  useEffect(() => {
    joinByCode(joinCode, {
      onSuccess: (meeting) => {
        navigate({ to: '/weldmeet/$meetingId/room', params: { meetingId: meeting.id } });
      },
      onError: () => {
        // Say why we are bouncing the user back instead of dropping them on the
        // meetings list with no explanation.
        // Read at call time so the effect doesn't depend on the translations.
        const copy = getTranslations('weldmeet').newMeetingPage;
        toast.error(copy.meetingNotFound, { description: copy.meetingNotFoundHint });
        navigate({ to: '/weldmeet' });
      },
    });
  }, [joinCode, joinByCode, navigate]);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
        <p className="text-muted-foreground">{t.joinByCodePage.joining}</p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/weldmeet/join/$joinCode')({
  component: JoinByCodePage,
});
