import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Recurring invoices',
  description: 'Manage WeldBooks recurring invoices via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
