import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Bills',
  description: 'Manage WeldBooks bills via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
