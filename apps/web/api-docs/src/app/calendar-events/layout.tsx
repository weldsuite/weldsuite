import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Events',
  description:
    'On this page, we will dive into the calendar event endpoints you can use to manage WeldCalendar events programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
