import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sprints',
  description:
    'On this page, we will dive into the sprint endpoints you can use to manage WeldFlow project sprints programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
