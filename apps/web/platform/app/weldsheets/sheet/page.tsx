import { useParams } from '@tanstack/react-router';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { LiveSheet } from './live-sheet';
import { LocalSheet } from './local-sheet';

/** One spreadsheet: co-edited through its room in a workspace, kept in the browser in the preview. */
export default function SheetPage() {
  // Not strict: the same page serves /weldsheets/$sheetId and its /preview mirror.
  const { sheetId = '' } = useParams({ strict: false });
  const preview = usePreviewMode();
  return preview ? <LocalSheet key={sheetId} sheetId={sheetId} /> : <LiveSheet key={sheetId} sheetId={sheetId} />;
}
