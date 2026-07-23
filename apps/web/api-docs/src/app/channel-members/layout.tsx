import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Channel Members',
  description:
    'On this page, we will dive into the channel member endpoints you can use to manage WeldChat channel membership programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
