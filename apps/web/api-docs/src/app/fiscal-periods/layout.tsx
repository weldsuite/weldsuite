import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Fiscal periods',
  description: 'On this page, we dive into the fiscal periods endpoints you can use to manage WeldBooks data programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
