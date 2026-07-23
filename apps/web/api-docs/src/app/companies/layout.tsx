import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Companies',
  description:
    'On this page, we will dive into the company endpoints you can use to manage CRM companies programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
