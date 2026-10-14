import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'WeldReach',
  description:
    'Overview of WeldReach on the external API: on-request access, per-mailbox billing, workspace limits, scopes, and the access and overview endpoints.',
}

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children
}
