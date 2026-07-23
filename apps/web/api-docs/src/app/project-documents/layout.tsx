import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Project Documents',
  description:
    'On this page, we will dive into the project document endpoints you can use to manage WeldFlow project documents programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
