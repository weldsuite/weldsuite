import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Project Sheets',
  description:
    'On this page, we will dive into the project sheet endpoint you can use to list WeldFlow project spreadsheet files programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
