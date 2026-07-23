import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Pipeline Stages',
  description:
    'On this page, we will dive into the pipeline stage endpoints you can use to manage CRM pipeline stages programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
