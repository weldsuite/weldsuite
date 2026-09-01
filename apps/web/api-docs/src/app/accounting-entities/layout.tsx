import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Accounting entities',
  description: 'Manage WeldBooks accounting entities via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
