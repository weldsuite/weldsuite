import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Invoices',
  description: 'Manage WeldBooks invoices via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
