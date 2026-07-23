import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Project Files',
  description:
    'On this page, we will dive into the project file endpoints you can use to manage WeldFlow project file attachments programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
