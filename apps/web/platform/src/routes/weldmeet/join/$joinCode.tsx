import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useJoinByCode } from '@/hooks/queries/use-weldmeet-queries';

function JoinByCodePage() {
  const { joinCode } = Route.useParams();
  const navigate = useNavigate();
  const joinByCode = useJoinByCode();

  useEffect(() => {
    joinByCode.mutate(joinCode, {
      onSuccess: (meeting) => {
        navigate({ to: '/weldmeet/$meetingId/room', params: { meetingId: meeting.id } });
      },
      onError: () => {
        navigate({ to: '/weldmeet' });
      },
    });
  }, [joinCode]);

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
        <p className="text-muted-foreground">Joining meeting...</p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/weldmeet/join/$joinCode')({
  component: JoinByCodePage,
});
