import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Pipelines',
  description:
    'On this page, we will dive into the pipeline endpoints you can use to manage CRM sales pipelines programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
