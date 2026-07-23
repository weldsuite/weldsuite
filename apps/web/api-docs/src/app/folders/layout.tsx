import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Folders',
  description:
    'On this page, we will dive into the folder endpoints you can use to manage WeldDrive folders programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
