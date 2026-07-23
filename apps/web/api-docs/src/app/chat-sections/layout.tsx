import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sections',
  description:
    'On this page, we will dive into the chat section endpoints you can use to manage WeldChat sidebar sections programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
