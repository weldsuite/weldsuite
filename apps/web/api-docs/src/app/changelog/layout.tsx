import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Changelog',
  description:
    'All notable changes and version history for the WeldSuite API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
