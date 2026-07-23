import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Bookmarks',
  description:
    'On this page, we will dive into the chat bookmark endpoints you can use to manage WeldChat message bookmarks programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
