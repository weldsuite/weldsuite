import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

/**
 * Copies text to the clipboard. `onCopied` (e.g. a success toast) runs only once
 * the write succeeds; a rejected write (permissions, insecure context) shows the
 * generic "Failed to copy" toast instead of a false success.
 */
export function copyText(text: string, onCopied?: () => void): void {
  navigator.clipboard.writeText(text).then(
    () => onCopied?.(),
    () => toast.error(getTranslations('sweep').shared.failedToCopy),
  );
}
