import { useLocalSearchParams } from 'expo-router';
import { ChannelView } from '@/components/chat/ChannelView';

export default function DmRoute() {
  const { channelId, name, type } = useLocalSearchParams<{
    channelId: string;
    name?: string;
    type?: string;
  }>();

  return <ChannelView channelId={channelId} initialName={name} initialType={type ?? 'dm'} />;
}
