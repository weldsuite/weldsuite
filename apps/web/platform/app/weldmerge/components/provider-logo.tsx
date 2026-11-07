import { Github, Gitlab } from 'lucide-react';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import { cn } from '@weldsuite/ui/lib/utils';

function BitbucketMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M3.5 4.5h17l-2.3 14.2a1 1 0 0 1-1 .8H6.8a1 1 0 0 1-1-.8L3.5 4.5Z" strokeLinejoin="round" />
      <path d="M9 14.5h6l.8-5H8.2l.8 5Z" strokeLinejoin="round" />
    </svg>
  );
}

function AzureMark({ className }: Readonly<{ className?: string }>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path d="M3 9.5 9 4v3.2L5.8 10.4 3 9.5Zm0 0v7l5 3.5 13-1V5.5L16 3v4l-7 .8v9.4l-1.5-.7" strokeLinejoin="round" />
    </svg>
  );
}

/** The mark of a git provider, in the current text colour. Decorative: the provider's name always sits next to it. */
export function ProviderLogo({ provider, className }: Readonly<{ provider: MergeProvider; className?: string }>) {
  const classes = cn('size-4 shrink-0', className);
  switch (provider) {
    case 'github':
      return <Github className={classes} aria-hidden="true" />;
    case 'gitlab':
      return <Gitlab className={classes} aria-hidden="true" />;
    case 'bitbucket':
      return <BitbucketMark className={classes} />;
    case 'azure_devops':
      return <AzureMark className={classes} />;
  }
}
