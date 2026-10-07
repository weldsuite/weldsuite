import { ChannelInboxClient, type ChannelInboxClientProps } from '../components/channel-inbox-client';

export default function DiscordListClient(props: Readonly<ChannelInboxClientProps>) {
  return <ChannelInboxClient channel="discord" {...props} />;
}
