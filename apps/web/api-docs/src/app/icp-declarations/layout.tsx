import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'ICP declarations',
  description: 'Manage WeldBooks icp declarations via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
