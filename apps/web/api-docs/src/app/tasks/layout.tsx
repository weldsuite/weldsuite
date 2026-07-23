import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Tasks',
  description:
    'Manage WeldFlow project tasks programmatically with the task endpoints.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
