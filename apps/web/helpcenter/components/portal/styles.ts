/** Shared Tailwind classes for the portal's forms, in the help center's zinc look. */

export const inputClass =
  'block w-full appearance-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm transition-colors ' +
  'placeholder:text-zinc-400 focus:border-[var(--hc-accent)] focus:ring-4 focus:ring-[var(--hc-accent)]/15 focus:outline-none ' +
  'disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:shadow-none dark:placeholder:text-zinc-500'

export const invalidInputClass = 'border-red-400! dark:border-red-500/70!'

export const labelClass = 'block text-sm font-medium text-zinc-900 dark:text-white'

export const helpTextClass = 'mt-1 text-xs text-zinc-500 dark:text-zinc-400'

export const fieldErrorClass = 'mt-1.5 text-sm text-red-600 dark:text-red-400'

export const primaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--hc-accent)] px-4 py-2 text-sm font-medium text-white shadow-sm transition ' +
  'hover:brightness-110 focus-visible:ring-4 focus-visible:ring-[var(--hc-accent)]/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60'

export const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors ' +
  'hover:border-zinc-300 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-700 dark:hover:text-white'

export const linkButtonClass =
  'text-sm font-medium text-[var(--hc-accent)] hover:underline disabled:cursor-not-allowed disabled:opacity-60'

export const cardClass = 'rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
