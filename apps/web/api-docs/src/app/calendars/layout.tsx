import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Calendars',
  description:
    'On this page, we will dive into the calendar endpoints you can use to manage WeldCalendar calendars programmatically.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
