import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Accounting settings',
  description: 'Read and update workspace-wide WeldBooks settings via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
