import { ChannelInboxClient, type ChannelInboxClientProps } from '../components/channel-inbox-client';

export default function EmailListClient(props: Readonly<ChannelInboxClientProps>) {
  return <ChannelInboxClient channel="email" {...props} />;
}
