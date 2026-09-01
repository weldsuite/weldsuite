import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Accounting documents',
  description: 'Manage WeldBooks accounting documents via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
