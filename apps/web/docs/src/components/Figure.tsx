'use client'

import { useCallback, useEffect, useState } from 'react'
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react'
import clsx from 'clsx'

const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3] as const

function ZoomIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" {...props}>
      <path d="M9 2a7 7 0 1 0 4.2 12.6l3.1 3.1 1.4-1.4-3.1-3.1A7 7 0 0 0 9 2Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z" />
    </svg>
  )
}

function ToolbarButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

export function Figure({
  src,
  alt,
  caption,
}: {
  src: string
  alt: string
  caption?: string
}) {
  const [open, setOpen] = useState(false)
  const [zoomIndex, setZoomIndex] = useState(0)

  const scale = ZOOM_STEPS[zoomIndex]
  const canZoomIn = zoomIndex < ZOOM_STEPS.length - 1
  const canZoomOut = zoomIndex > 0

  const zoomIn = useCallback(
    () => setZoomIndex((i) => Math.min(i + 1, ZOOM_STEPS.length - 1)),
    [],
  )
  const zoomOut = useCallback(
    () => setZoomIndex((i) => Math.max(i - 1, 0)),
    [],
  )
  const resetZoom = useCallback(() => setZoomIndex(0), [])

  useEffect(() => {
    if (!open) {
      setZoomIndex(0)
      return
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomIn()
      } else if (event.key === '-') {
        event.preventDefault()
        zoomOut()
      } else if (event.key === '0') {
        event.preventDefault()
        resetZoom()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, zoomIn, zoomOut, resetZoom])

  return (
    <>
      <figure
        className={clsx(
          'not-prose my-10 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950',
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group relative block w-full cursor-zoom-in text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950"
          aria-label={`View larger: ${alt}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className="block h-auto w-full" />
          <span className="pointer-events-none absolute inset-0 bg-slate-900/0 transition group-hover:bg-slate-900/5 dark:group-hover:bg-slate-950/20" />
          <span className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full bg-slate-900/75 px-2.5 py-1 text-xs font-medium text-white opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
            <ZoomIcon className="h-3.5 w-3.5" />
            Click to enlarge
          </span>
        </button>
        {caption ? (
          <figcaption className="border-t border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
            {caption}
          </figcaption>
        ) : null}
      </figure>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        className="fixed inset-0 z-50"
      >
        <div
          className="fixed inset-0 bg-slate-950/90 backdrop-blur-sm"
          aria-hidden="true"
        />

        <div className="fixed inset-0 flex flex-col">
          <DialogPanel className="flex min-h-0 flex-1 flex-col">
            <DialogTitle className="sr-only">{alt}</DialogTitle>

            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
              <p className="truncate text-sm text-slate-300">{alt}</p>
              <div className="flex shrink-0 items-center gap-1.5">
                <ToolbarButton
                  onClick={zoomOut}
                  disabled={!canZoomOut}
                  label="Zoom out"
                >
                  −
                </ToolbarButton>
                <span className="min-w-[3.5rem] text-center text-sm tabular-nums text-slate-300">
                  {Math.round(scale * 100)}%
                </span>
                <ToolbarButton
                  onClick={zoomIn}
                  disabled={!canZoomIn}
                  label="Zoom in"
                >
                  +
                </ToolbarButton>
                <ToolbarButton onClick={resetZoom} label="Reset zoom">
                  Reset
                </ToolbarButton>
                <ToolbarButton onClick={() => setOpen(false)} label="Close">
                  Close
                </ToolbarButton>
              </div>
            </div>

            <div
              className="min-h-0 flex-1 overflow-auto p-4 sm:p-8"
              onClick={() => setOpen(false)}
            >
              <div
                className="mx-auto min-w-min"
                style={{ width: `${scale * 100}%`, maxWidth: scale === 1 ? 'min(96vw, 1200px)' : 'none' }}
                onClick={(event) => event.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt={alt}
                  className="block h-auto w-full rounded-lg shadow-2xl ring-1 ring-white/10"
                  draggable={false}
                />
              </div>
            </div>

            {caption ? (
              <p className="shrink-0 border-t border-white/10 px-4 py-3 text-center text-sm text-slate-400 sm:px-6">
                {caption}
              </p>
            ) : null}
          </DialogPanel>
        </div>
      </Dialog>
    </>
  )
}
