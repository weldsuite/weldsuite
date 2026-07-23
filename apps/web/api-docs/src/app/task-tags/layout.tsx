import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Task Tags',
  description:
    'On this page, we will dive into the task tag endpoints you can use to manage WeldFlow task tags programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
