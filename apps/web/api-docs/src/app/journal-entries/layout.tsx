import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Journal entries',
  description: 'Manage WeldBooks journal entries via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
