import { ChannelInboxClient, type ChannelInboxClientProps } from '../components/channel-inbox-client';

export default function SlackListClient(props: Readonly<ChannelInboxClientProps>) {
  return <ChannelInboxClient channel="slack" {...props} />;
}
