'use client'

import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import clsx from 'clsx'
import Link from 'next/link'

import {
  API_VERSIONS,
  useVersion,
  useSetVersion,
  type ApiVersion,
} from '@/components/VersionProvider'

type VersionStatus = ApiVersion['status']

const statusStyles: Record<VersionStatus, string> = {
  current: 'bg-emerald-400/10 text-emerald-500 dark:text-emerald-400',
  supported: 'bg-sky-400/10 text-sky-500 dark:text-sky-400',
  deprecated: 'bg-amber-400/10 text-amber-500 dark:text-amber-400',
}

const statusLabels: Record<VersionStatus, string> = {
  current: 'Current',
  supported: 'Supported',
  deprecated: 'Deprecated',
}

function ChevronDownIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg viewBox="0 0 8 6" aria-hidden="true" {...props}>
      <path
        d="M1.75 1.75 4 4.25l2.25-2.5"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" {...props}>
      <path
        fillRule="evenodd"
        d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
        clipRule="evenodd"
      />
    </svg>
  )
}

function StatusBadge({ status }: { status: VersionStatus }) {
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase',
        statusStyles[status]
      )}
    >
      {statusLabels[status]}
    </span>
  )
}

export function VersionSelector() {
  const selectedVersion = useVersion()
  const setSelectedVersion = useSetVersion()

  const currentVersionInfo = API_VERSIONS.find(
    (v) => v.version === selectedVersion
  ) ?? API_VERSIONS[0]

  return (
    <Menu as="div" className="relative">
      <MenuButton
        className={clsx(
          'flex items-center gap-1.5 rounded-full px-3 py-1',
          'text-xs font-medium',
          'bg-zinc-900/5 text-zinc-700 hover:bg-zinc-900/10',
          'dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10',
          'transition-colors'
        )}
      >
        <span className="font-mono">{currentVersionInfo.version}</span>
        <StatusBadge status={currentVersionInfo.status} />
        <ChevronDownIcon className="h-1.5 w-2 stroke-current" />
      </MenuButton>
      <MenuItems
        anchor="bottom end"
        className={clsx(
          'z-50 mt-2 w-72 origin-top-right rounded-xl p-1',
          'bg-white shadow-lg ring-1 ring-zinc-900/5',
          'dark:bg-zinc-900 dark:ring-white/10',
          'focus:outline-none'
        )}
      >
        <div className="px-3 py-2">
          <p className="text-xs font-semibold text-zinc-900 dark:text-white">
            API Version
          </p>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            View documentation for a specific version
          </p>
        </div>
        <div className="h-px bg-zinc-900/5 dark:bg-white/5" />
        {API_VERSIONS.map((version) => (
          <MenuItem key={version.version}>
            {({ focus }) => (
              <button
                onClick={() => setSelectedVersion(version.version)}
                className={clsx(
                  'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left',
                  focus && 'bg-zinc-50 dark:bg-white/5'
                )}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-zinc-900 dark:text-white">
                      {version.version}
                    </span>
                    <StatusBadge status={version.status} />
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {version.description}
                  </p>
                </div>
                {version.version === selectedVersion && (
                  <CheckIcon className="h-5 w-5 flex-none text-emerald-500" />
                )}
              </button>
            )}
          </MenuItem>
        ))}
        <div className="h-px bg-zinc-900/5 dark:bg-white/5" />
        <div className="px-3 py-2">
          <Link
            href="/changelog"
            className="text-xs font-medium text-emerald-500 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
          >
            View full changelog &rarr;
          </Link>
        </div>
      </MenuItems>
    </Menu>
  )
}

/**
 * Inline version indicator for resource pages
 */
export function VersionIndicator() {
  const selectedVersion = useVersion()
  const versionInfo = API_VERSIONS.find((v) => v.version === selectedVersion)

  if (!versionInfo) return null

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">Viewing docs for</span>
      <span className="font-mono font-medium text-zinc-900 dark:text-white">
        {versionInfo.version}
      </span>
      <StatusBadge status={versionInfo.status} />
    </div>
  )
}
