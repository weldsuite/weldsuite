import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'People',
  description:
    'On this page, we will dive into the people endpoints you can use to manage CRM contacts programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
