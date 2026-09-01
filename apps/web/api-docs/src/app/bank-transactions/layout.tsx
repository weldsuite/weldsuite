import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Bank transactions',
  description: 'Manage WeldBooks bank transactions via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
