import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'OData feed (BI)',
  description: 'On this page, we dive into the read-only OData feed you can connect Power BI, Excel and other BI tools to, to read helpdesk data.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
