import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Project Messages',
  description:
    'On this page, we will dive into the project message endpoints you can use to manage WeldFlow project messages programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
