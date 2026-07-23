import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Time Entries',
  description:
    'Log and manage WeldFlow time entries programmatically with the time-entry endpoints.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
