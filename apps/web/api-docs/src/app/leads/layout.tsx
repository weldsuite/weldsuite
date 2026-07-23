import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Leads',
  description:
    'On this page, we will dive into the lead endpoints you can use to manage sales leads programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
