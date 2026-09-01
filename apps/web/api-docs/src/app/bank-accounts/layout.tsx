import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Bank accounts',
  description: 'Manage WeldBooks bank accounts via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
