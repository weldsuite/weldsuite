import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Authentication',
  description:
    'Learn how to authenticate with the WeldSuite External API using API keys with fine-grained permission scopes.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
