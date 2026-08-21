import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Manage DNS records',
  description:
    'Add, edit, and delete DNS records for a domain in WeldHost — A, AAAA, CNAME, MX, TXT, NS, SRV, and CAA.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
