import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Projects',
  description:
    'Manage WeldFlow projects programmatically with the project endpoints.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
