import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Tax rates',
  description: 'Manage WeldBooks tax rates via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
