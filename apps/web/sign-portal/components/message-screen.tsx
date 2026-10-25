import { Signature } from 'lucide-react';

/** Centred card with a title and a line of text, for the portal's static states. */
export function MessageScreen({ title, body, footer }: Readonly<{ title: string; body: string; footer: string }>) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/30 p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border bg-card p-8 text-center shadow-sm">
        <Signature className="size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <p className="text-xs text-muted-foreground">{footer}</p>
    </main>
  );
}
