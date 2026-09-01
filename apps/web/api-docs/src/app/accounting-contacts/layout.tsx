import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Accounting contacts',
  description: 'Manage WeldBooks accounting contacts via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
