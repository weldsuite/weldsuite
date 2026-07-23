import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Task Comments',
  description:
    'On this page, we will dive into the task comment endpoints you can use to manage WeldFlow task comments programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
