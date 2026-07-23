import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Whiteboards',
  description:
    'On this page, we will dive into the whiteboard endpoints you can use to manage WeldFlow project whiteboards programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
