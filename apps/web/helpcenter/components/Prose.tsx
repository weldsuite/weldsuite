import clsx from 'clsx'

export function Prose<T extends React.ElementType = 'div'>({
  as,
  className,
  ...props
}: React.ComponentPropsWithoutRef<T> & { as?: T }) {
  let Component = as ?? 'div'
  return (
    <Component
      className={clsx(
        className,
        'prose prose-zinc max-w-none dark:prose-invert',
        'prose-headings:scroll-mt-24 prose-headings:font-semibold prose-headings:tracking-tight',
        'prose-a:font-medium prose-a:text-[var(--hc-accent)] prose-a:no-underline hover:prose-a:underline',
        'prose-pre:rounded-xl prose-pre:bg-zinc-900 prose-pre:ring-1 prose-pre:ring-zinc-800',
        'prose-img:rounded-xl prose-img:ring-1 prose-img:ring-zinc-200 dark:prose-img:ring-zinc-800',
        'prose-hr:border-zinc-200 dark:prose-hr:border-zinc-800',
      )}
      {...props}
    />
  )
}
