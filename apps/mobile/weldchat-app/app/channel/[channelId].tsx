import { useLocalSearchParams } from 'expo-router';
import { ChannelView } from '@/components/chat/ChannelView';

export default function ChannelRoute() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();

  return <ChannelView channelId={channelId} />;
}
