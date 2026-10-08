import { FileX } from 'lucide-react';

/** Shown when the entity's jurisdiction has no VAT return in WeldBooks (yet). */
export function VatNotAvailable({ title, description }: Readonly<{ title: string; description: string }>) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <FileX className="h-10 w-10 text-muted-foreground" aria-hidden />
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
