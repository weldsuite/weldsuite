import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Pagination',
  description:
    'In this guide, we will look at how to work with cursor-paginated responses when querying the WeldSuite API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
