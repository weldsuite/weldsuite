import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'WeldHost',
  description:
    'Manage domains, DNS, SSL, and email routing in WeldHost — the hosting layer for WeldSuite.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
