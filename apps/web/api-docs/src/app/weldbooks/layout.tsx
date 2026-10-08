import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'WeldBooks',
  description: 'Overview of WeldBooks on the external API — accounting entities, entityId scoping, list filters, and which resources are read-only.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
