import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Drive',
  description:
    'On this page, we will dive into the drive endpoints you can use to access the unified WeldDrive feed and storage statistics.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
