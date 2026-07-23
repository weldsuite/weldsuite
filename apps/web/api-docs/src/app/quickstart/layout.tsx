import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Quickstart',
  description:
    'Get started with the WeldSuite API in minutes. Learn how to create an API key with scopes and make your first API request.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
