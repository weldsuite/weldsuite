import { type Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Boards',
  description:
    'The board endpoints: find, read, create and change WeldBoard whiteboards, and put sticky notes, shapes, frames, arrows and mind maps on them.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
