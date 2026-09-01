import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Reconciliation rules',
  description: 'On this page, we dive into the reconciliation rules endpoints you can use to manage WeldBooks data programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
