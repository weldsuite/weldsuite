import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Files',
  description:
    'On this page, we will dive into the file endpoints you can use to manage WeldDrive file metadata programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
