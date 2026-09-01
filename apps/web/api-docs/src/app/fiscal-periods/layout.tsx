import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Fiscal periods',
  description: 'Manage WeldBooks fiscal periods via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
