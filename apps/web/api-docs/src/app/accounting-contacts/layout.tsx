import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Accounting contacts',
  description: 'On this page, we dive into the accounting contacts endpoints you can use to manage WeldBooks data programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
