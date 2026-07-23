import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Opportunities',
  description:
    'Manage CRM sales opportunities (deals) programmatically with the opportunity endpoints.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
