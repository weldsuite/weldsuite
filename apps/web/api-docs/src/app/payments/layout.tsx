import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Payments',
  description: 'Manage WeldBooks payments via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
