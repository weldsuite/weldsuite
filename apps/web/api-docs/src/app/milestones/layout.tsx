import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Milestones',
  description:
    'On this page, we will dive into the milestone endpoints you can use to manage WeldFlow project milestones programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
