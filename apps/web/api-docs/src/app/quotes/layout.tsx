import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Quotes',
  description:
    'Create and manage CRM quotes programmatically with the quote endpoints.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
