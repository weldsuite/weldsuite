import { useCallback, useEffect, useState } from 'react';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { log } from '@/lib/logger';
import { isStaleChunkError, reloadForStaleChunk } from '@/lib/chunk-reload';

function DevErrorDetails({ error, componentStack }: { error: Error; componentStack?: string }) {
  const [copied, setCopied] = useState(false);

  const fullText = [error.stack, componentStack && `\nComponent Stack:\n${componentStack}`]
    .filter(Boolean)
    .join('');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [fullText]);

  return (
    <div className="mx-auto mt-8 max-w-2xl text-left">
      <details open>
        <summary className="cursor-pointer text-sm font-medium text-destructive">
          {error.name}: {error.message}
        </summary>
        <div className="relative mt-2">
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 h-7 w-7"
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          {error.stack && (
            <pre className="overflow-auto rounded-md bg-muted p-4 pr-10 text-xs">
              {error.stack}
            </pre>
          )}
        </div>
        {componentStack && (
          <pre className="mt-2 overflow-auto rounded-md bg-muted p-4 text-xs">
            {componentStack}
          </pre>
        )}
      </details>
    </div>
  );
}

export function RootErrorFallback({ error, info, reset }: ErrorComponentProps) {
  // A stale dynamic import (chunk removed by a redeploy) surfaces here as a
  // render error. Reload once to pick up the latest build rather than showing
  // a dead-end error screen. The guard in reloadForStaleChunk prevents loops.
  const reloading = isStaleChunkError(error) && reloadForStaleChunk();

  useEffect(() => {
    if (reloading) return;
    log.error('Unhandled rendering error', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack: info?.componentStack,
    });
  }, [error, info, reloading]);

  if (reloading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Updating to the latest version…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-destructive" />
        <h1 className="mt-4 text-4xl font-bold">Something went wrong</h1>
        <p className="mt-2 text-muted-foreground">
          We're sorry, an unexpected error occurred. Please try again.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Link to="/" className="text-sm text-primary underline">
            Go home
          </Link>
        </div>

        {import.meta.env.DEV && error instanceof Error && (
          <DevErrorDetails error={error} componentStack={info?.componentStack} />
        )}
      </div>
    </div>
  );
}
