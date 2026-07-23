import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Versioning',
  description:
    'Learn about API versioning and how to work with different versions of the WeldSuite API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
