import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Goals',
  description:
    'On this page, we will dive into the goal endpoints you can use to manage WeldFlow project goals programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
