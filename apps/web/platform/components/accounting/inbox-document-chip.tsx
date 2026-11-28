/**
 * A chip for an inbox document (a scanned receipt or purchase invoice). The
 * inbox has no object panel, so the chip opens the documents page with that
 * document's dialog (`?document=<id>`); Cmd/Ctrl-click opens it in a new tab.
 */

import { FileText } from 'lucide-react';
import { RecordChip } from '@weldsuite/ui/components/record-chip';
import { useRouter } from '@/lib/router';

export function inboxDocumentHref(id: string): string {
  return `/weldbooks/documents?document=${encodeURIComponent(id)}`;
}

export function InboxDocumentChip({ id, fileName }: Readonly<{ id: string; fileName: string }>) {
  const router = useRouter();
  const href = inboxDocumentHref(id);
  return <RecordChip icon={FileText} label={fileName} href={href} onOpen={() => router.push(href)} />;
}
