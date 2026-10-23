import { useLocalSearchParams } from 'expo-router';
import { ChannelView } from '@/components/chat/ChannelView';

export default function ChannelRoute() {
  // `name` / `type` come from the list row that was tapped, so the header and
  // composer have a name while the channel itself is still loading.
  const { channelId, name, type } = useLocalSearchParams<{
    channelId: string;
    name?: string;
    type?: string;
  }>();

  return <ChannelView channelId={channelId} initialName={name} initialType={type} />;
}
