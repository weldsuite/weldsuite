import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Audit logs',
  description: 'On this page, we dive into the audit log endpoints you can use to read a workspace audit trail, and how to stream it to a SIEM.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
