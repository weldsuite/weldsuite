import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'VAT returns',
  description: 'Manage WeldBooks vat returns via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
