import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Channels',
  description:
    'On this page, we will dive into the channel endpoints you can use to manage WeldChat channels programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
