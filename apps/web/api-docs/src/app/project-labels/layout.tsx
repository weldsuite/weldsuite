import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Project Labels',
  description:
    'On this page, we will dive into the project label endpoints you can use to manage WeldFlow project labels programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
