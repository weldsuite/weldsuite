import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Drafts',
  description:
    'On this page, we will dive into the chat draft endpoints you can use to manage WeldChat message drafts programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
