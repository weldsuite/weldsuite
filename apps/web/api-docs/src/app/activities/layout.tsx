import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Activities',
  description:
    'Log and manage CRM activities — calls, emails, meetings, tasks, and notes — programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
