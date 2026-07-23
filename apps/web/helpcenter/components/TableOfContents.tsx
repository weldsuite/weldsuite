'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import clsx from 'clsx'

interface Heading {
  id: string
  text: string
  level: number
}

export function TableOfContents({ headings }: { headings: Heading[] }) {
  const [currentSection, setCurrentSection] = useState(headings[0]?.id)

  const getHeadingPositions = useCallback(() => {
    return headings
      .map(({ id }) => {
        const el = document.getElementById(id)
        if (!el) return null
        const style = window.getComputedStyle(el)
        const scrollMt = parseFloat(style.scrollMarginTop)
        const top = window.scrollY + el.getBoundingClientRect().top - scrollMt
        return { id, top }
      })
      .filter((x): x is { id: string; top: number } => x !== null)
  }, [headings])

  useEffect(() => {
    if (headings.length === 0) return
    let positions = getHeadingPositions()

    function onScroll() {
      const top = window.scrollY
      let current = positions[0]?.id
      for (const pos of positions) {
        if (top >= pos.top - 10) current = pos.id
        else break
      }
      if (current) setCurrentSection(current)
    }

    // Re-measure on resize since heading offsets shift with layout.
    function onResize() {
      positions = getHeadingPositions()
      onScroll()
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [getHeadingPositions, headings])

  if (headings.length === 0) return null

  return (
    <div className="hidden w-56 shrink-0 xl:block">
      <nav aria-labelledby="on-this-page-title" className="sticky top-24 py-4">
        <h2
          id="on-this-page-title"
          className="text-xs font-semibold tracking-wide text-zinc-400 uppercase dark:text-zinc-500"
        >
          On this page
        </h2>
        <ol role="list" className="mt-4 space-y-2.5 text-sm">
          {headings.map((heading) => (
            <li key={heading.id} className={heading.level === 3 ? 'pl-4' : ''}>
              <Link
                href={`#${heading.id}`}
                className={clsx(
                  'block transition-colors',
                  currentSection === heading.id
                    ? 'font-medium text-[var(--hc-accent)]'
                    : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
                )}
              >
                {heading.text}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  )
}
