import { createFileRoute } from '@tanstack/react-router';
import CallRoomPage from '@/app/weldchat/call-room/page';

export const Route = createFileRoute('/call-room')({
  component: CallRoomPage,
});
