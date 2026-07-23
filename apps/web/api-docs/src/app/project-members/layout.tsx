import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Project Members',
  description:
    'On this page, we will dive into the project member endpoints you can use to manage WeldFlow project membership programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
