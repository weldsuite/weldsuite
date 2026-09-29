import clsx from 'clsx'

export function Video({
  src,
  poster,
  title,
  caption,
}: Readonly<{
  src: string
  poster?: string
  title: string
  caption?: string
}>) {
  return (
    <figure
      className={clsx(
        'not-prose my-10 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950',
      )}
    >
      <video
        controls
        playsInline
        preload="metadata"
        poster={poster}
        aria-label={title}
        className="block h-auto w-full bg-slate-900"
      >
        <source src={src} type={src.endsWith('.webm') ? 'video/webm' : 'video/mp4'} />
      </video>
      {caption ? (
        <figcaption className="border-t border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  )
}
