'use client'

import clsx from 'clsx'

import {
  useVersion,
  isVersionAtLeast,
  isVersionBefore,
  CURRENT_VERSION,
  API_VERSIONS,
} from '@/components/VersionProvider'

interface VersionSinceProps {
  version: string
  children: React.ReactNode
}

/**
 * Only shows content if the selected version is >= the specified version.
 * Use this for features added in a specific version.
 *
 * @example
 * <VersionSince version="2024-12-01">
 *   This content only shows for 2024-12-01 and later
 * </VersionSince>
 */
export function VersionSince({ version, children }: VersionSinceProps) {
  const selectedVersion = useVersion()

  if (!isVersionAtLeast(selectedVersion, version)) {
    return null
  }

  return <>{children}</>
}

interface VersionBeforeProps {
  version: string
  children: React.ReactNode
}

/**
 * Only shows content if the selected version is < the specified version.
 * Use this for deprecated features that were removed in a version.
 *
 * @example
 * <VersionBefore version="2024-12-01">
 *   This content only shows for versions before 2024-12-01
 * </VersionBefore>
 */
export function VersionBefore({ version, children }: VersionBeforeProps) {
  const selectedVersion = useVersion()

  if (!isVersionBefore(selectedVersion, version)) {
    return null
  }

  return <>{children}</>
}

interface VersionSwitchProps {
  children: React.ReactNode
}

interface VersionCaseProps {
  version: string
  children: React.ReactNode
}

/**
 * Switch between different content based on version.
 *
 * @example
 * <VersionSwitch>
 *   <VersionCase version="2024-12-01">
 *     Content for 2024-12-01 and later
 *   </VersionCase>
 *   <VersionCase version="2024-11-30">
 *     Content for 2024-11-30
 *   </VersionCase>
 * </VersionSwitch>
 */
export function VersionSwitch({ children }: VersionSwitchProps) {
  return <>{children}</>
}

export function VersionCase({ version, children }: VersionCaseProps) {
  const selectedVersion = useVersion()

  if (selectedVersion !== version) {
    return null
  }

  return <>{children}</>
}

interface VersionBadgeProps {
  since?: string
  until?: string
  deprecated?: string
}

/**
 * Shows a badge indicating version availability.
 *
 * @example
 * <VersionBadge since="2024-12-01" />
 * <VersionBadge deprecated="2024-12-01" />
 */
export function VersionBadge({ since, until, deprecated }: VersionBadgeProps) {
  const selectedVersion = useVersion()

  if (deprecated && isVersionAtLeast(selectedVersion, deprecated)) {
    return (
      <span className="ml-2 rounded bg-amber-400/10 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase text-amber-500 dark:text-amber-400">
        Deprecated
      </span>
    )
  }

  if (since && !isVersionAtLeast(selectedVersion, since)) {
    return (
      <span className="ml-2 rounded bg-zinc-400/10 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase text-zinc-500 dark:text-zinc-400">
        Added in {since}
      </span>
    )
  }

  if (until && isVersionAtLeast(selectedVersion, until)) {
    return (
      <span className="ml-2 rounded bg-rose-400/10 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase text-rose-500 dark:text-rose-400">
        Removed in {until}
      </span>
    )
  }

  if (since) {
    return (
      <span className="ml-2 rounded bg-emerald-400/10 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase text-emerald-500 dark:text-emerald-400">
        New
      </span>
    )
  }

  return null
}

interface VersionWarningProps {
  type: 'not-available' | 'deprecated' | 'changed'
  version: string
  message?: string
}

/**
 * Shows a warning banner for version-specific issues.
 */
export function VersionWarning({ type, version, message }: VersionWarningProps) {
  const styles = {
    'not-available': {
      bg: 'bg-zinc-50 dark:bg-zinc-800/50',
      border: 'border-zinc-200 dark:border-zinc-700',
      text: 'text-zinc-700 dark:text-zinc-300',
      icon: (
        <svg className="h-5 w-5 text-zinc-400" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
            clipRule="evenodd"
          />
        </svg>
      ),
    },
    deprecated: {
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      border: 'border-amber-200 dark:border-amber-800',
      text: 'text-amber-800 dark:text-amber-200',
      icon: (
        <svg className="h-5 w-5 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
      ),
    },
    changed: {
      bg: 'bg-sky-50 dark:bg-sky-900/20',
      border: 'border-sky-200 dark:border-sky-800',
      text: 'text-sky-800 dark:text-sky-200',
      icon: (
        <svg className="h-5 w-5 text-sky-500" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z"
            clipRule="evenodd"
          />
        </svg>
      ),
    },
  }

  const style = styles[type]
  const defaultMessages = {
    'not-available': `This feature is not available in version ${version}. It was added in a later version.`,
    deprecated: `This feature is deprecated as of version ${version}.`,
    changed: `This feature was changed in version ${version}.`,
  }

  return (
    <div
      className={clsx(
        'my-6 flex gap-3 rounded-lg border p-4',
        style.bg,
        style.border
      )}
    >
      {style.icon}
      <p className={clsx('text-sm', style.text)}>
        {message || defaultMessages[type]}
      </p>
    </div>
  )
}

/**
 * A banner that shows at the top of resource pages indicating the current version
 * and allows switching.
 */
export function ResourceVersionBanner() {
  const selectedVersion = useVersion()
  const versionInfo = API_VERSIONS.find((v) => v.version === selectedVersion)
  const isCurrent = selectedVersion === CURRENT_VERSION

  if (!versionInfo) return null

  return (
    <div
      className={clsx(
        'not-prose mb-8 flex items-center gap-3 rounded-lg border px-4 py-3',
        isCurrent
          ? 'border-emerald-500/20 bg-emerald-50/50 dark:border-emerald-500/30 dark:bg-emerald-500/5'
          : 'border-sky-500/20 bg-sky-50/50 dark:border-sky-500/30 dark:bg-sky-500/5'
      )}
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className={clsx(
          'h-5 w-5 flex-none',
          isCurrent
            ? 'text-emerald-500 dark:text-emerald-400'
            : 'text-sky-500 dark:text-sky-400'
        )}
      >
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
          clipRule="evenodd"
        />
      </svg>
      <p
        className={clsx(
          'text-sm',
          isCurrent
            ? 'text-emerald-900 dark:text-emerald-200'
            : 'text-sky-900 dark:text-sky-200'
        )}
      >
        <span className="font-medium">
          Viewing version{' '}
          <code className="font-mono">{versionInfo.version}</code>
        </span>
        {isCurrent ? (
          <span className="text-emerald-700 dark:text-emerald-300">
            {' '}— This is the current version
          </span>
        ) : (
          <span className="text-sky-700 dark:text-sky-300">
            {' '}— <a href="/changelog" className="underline hover:no-underline">See what&apos;s new</a> in the latest version
          </span>
        )}
      </p>
    </div>
  )
}
