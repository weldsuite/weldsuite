import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'GL accounts',
  description: 'Manage WeldBooks gl accounts via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
