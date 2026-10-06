import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { cn } from '@weldsuite/ui/lib/utils';
import type { MeetingToolsLabels } from '../../tools/labels';
import type { TranscriptLine } from '../../tools/use-meeting-tools';

export interface TranscriptToolProps {
  lines: TranscriptLine[];
  /** Maps a line to the viewer's language when translation is on (identity otherwise). */
  translate: (text: string) => string;
  captionsOn: boolean;
  onCaptionsChange: (on: boolean) => void;
  meetingTitle?: string;
  labels: MeetingToolsLabels;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function toPlainText(lines: TranscriptLine[], translate: (text: string) => string): string {
  return lines
    .filter((line) => !line.isPartial)
    .map((line) => `[${formatTime(line.at)}] ${line.speakerName}: ${translate(line.text)}`)
    .join('\n');
}

export function TranscriptTool({
  lines,
  translate,
  captionsOn,
  onCaptionsChange,
  meetingTitle,
  labels,
}: TranscriptToolProps) {
  const t = labels.transcript;
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the conversation unless the reader scrolled up to look at something.
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const hasFinalLines = lines.some((line) => !line.isPartial);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(toPlainText(lines, translate));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  const handleDownload = () => {
    const title = meetingTitle?.trim() || t.fileTitle;
    const blob = new Blob([`${title}\n\n${toPlainText(lines, translate)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'transcript'}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 space-y-3 border-b p-4">
        <label className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t.captions}</span>
            <span className="block text-xs text-muted-foreground">{t.captionsHint}</span>
          </span>
          <Switch checked={captionsOn} onCheckedChange={onCaptionsChange} aria-label={t.captions} />
        </label>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!hasFinalLines} onClick={handleCopy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t.copied : t.copy}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!hasFinalLines} onClick={handleDownload}>
            <Download className="h-3.5 w-3.5" />
            {t.download}
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          <ol className="space-y-3">
            {lines.map((line) => (
              <li key={line.id} className="text-sm leading-snug">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{line.speakerName}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{formatTime(line.at)}</span>
                </div>
                <p className={cn(line.isPartial && 'text-muted-foreground')}>{translate(line.text)}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
