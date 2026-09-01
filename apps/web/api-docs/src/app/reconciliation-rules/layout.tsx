import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Reconciliation rules',
  description: 'Manage WeldBooks reconciliation rules via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
