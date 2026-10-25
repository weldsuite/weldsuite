/**
 * The "Send for signature" entry of a menu on a WeldDrive PDF or a CRM record.
 * Put it inside the menu's content: it mounts when the menu opens, and it
 * renders nothing where WeldSign is not installed or the member may not create
 * requests.
 */

import { Signature } from 'lucide-react';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import { isSignablePdf, type SignStartSource } from '../lib/source';
import { useStartSignRequest } from './use-start-sign-request';

interface SendForSignatureItemProps {
  source: SignStartSource;
  /** Classes of the icon, where the menu styles its icons itself. */
  iconClassName?: string;
}

export function SendForSignatureItem({ source, iconClassName }: Readonly<SendForSignatureItemProps>) {
  const { t } = useI18n();
  const { available, starting, start } = useStartSignRequest();
  if (!available) return null;

  return (
    <DropdownMenuItem disabled={starting} onClick={() => void start(source)}>
      <Signature className={iconClassName} />
      {t.weldsign.start.action}
    </DropdownMenuItem>
  );
}

interface SendFileForSignatureItemProps {
  file: { id: string; name: string; mimeType: string | null; fileType: string; source: string };
  iconClassName?: string;
}

/** The same for a WeldDrive file: only a PDF in the Drive file store can be signed. */
export function SendFileForSignatureItem({ file, iconClassName }: Readonly<SendFileForSignatureItemProps>) {
  if (!isSignablePdf(file)) return null;
  return <SendForSignatureItem source={{ entityType: 'file', id: file.id, name: file.name }} iconClassName={iconClassName} />;
}
