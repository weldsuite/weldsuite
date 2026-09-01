import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'FX rates',
  description: 'Manage WeldBooks fx rates via the external API.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
