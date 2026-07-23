import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Messages',
  description:
    'On this page, we will dive into the chat message endpoints you can use to manage WeldChat messages programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
