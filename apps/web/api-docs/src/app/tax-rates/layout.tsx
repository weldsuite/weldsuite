import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Tax rates',
  description: 'On this page, we dive into the tax rates endpoints you can use to manage WeldBooks data programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
