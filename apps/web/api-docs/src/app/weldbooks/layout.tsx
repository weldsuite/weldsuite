import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'WeldBooks',
  description: 'Overview of WeldBooks on the external API — accounting entities, entityId scoping, and list filters.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
