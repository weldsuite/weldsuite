import { useEffect } from 'react';
import { Bot, X, ExternalLink, CheckCircle2, XCircle, Loader2, Timer } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { useAgent } from '@/hooks/queries/use-agent-queries';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

export interface AgentProfilePanelProps {
  agentId: string;
  isOpen: boolean;
  onClose: () => void;
  /** Skip the slide-in animation when opened on top of another panel. */
  skipAnimation?: boolean;
}

/** Matches TeamMemberDetailsPanel's collapsed width so the layout stays consistent. */
const PANEL_WIDTH = '480px';
const PANEL_WIDTH_NUM = 480;

const STATUS_COLORS: Record<string, { dot: string; text: string; label: string }> = {
  active: { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400', label: 'Active' },
  paused: { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400', label: 'Paused' },
  draft: { dot: 'bg-muted-foreground', text: 'text-muted-foreground', label: 'Draft' },
};

const RUN_STATUS_ICON: Record<string, { icon: typeof CheckCircle2; className: string; label: string }> = {
  completed: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400', label: 'Completed' },
  failed: { icon: XCircle, className: 'text-red-600 dark:text-red-400', label: 'Failed' },
  running: { icon: Loader2, className: 'text-blue-600 dark:text-blue-400 animate-spin', label: 'Running' },
  cancelled: { icon: XCircle, className: 'text-gray-500', label: 'Cancelled' },
  budget_deferred: { icon: Timer, className: 'text-amber-600 dark:text-amber-400', label: 'Deferred' },
};

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatRelative(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function AgentProfilePanel({ agentId, isOpen, onClose, skipAnimation }: AgentProfilePanelProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const { data: agent, isLoading } = useAgent(agentId);

  const statusLabels: Record<string, string> = {
    active: st('sweep.weldchat.agentProfilePanel.statusActive'),
    paused: st('sweep.weldchat.agentProfilePanel.statusPaused'),
    draft: st('sweep.weldchat.agentProfilePanel.statusDraft'),
  };
  const runStatusLabels: Record<string, string> = {
    completed: st('sweep.weldchat.agentProfilePanel.runStatusCompleted'),
    failed: st('sweep.weldchat.agentProfilePanel.runStatusFailed'),
    running: st('sweep.weldchat.agentProfilePanel.runStatusRunning'),
    cancelled: st('sweep.weldchat.agentProfilePanel.runStatusCancelled'),
    budget_deferred: st('sweep.weldchat.agentProfilePanel.runStatusDeferred'),
  };

  // Mirror TeamMemberDetailsPanel: emit `member-detail-panel` so the chat
  // layout shrinks the message column to make room for this panel.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('member-detail-panel', {
        detail: { isOpen, width: PANEL_WIDTH_NUM },
      }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent('member-detail-panel', { detail: { isOpen: false, width: 0 } }),
      );
    };
  }, [isOpen]);

  // Close panel when someone asks all detail panels to close (e.g. WeldAgent opens)
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, [onClose]);

  if (!isOpen) return null;

  const statusConfig =
    STATUS_COLORS[(agent as any)?.status] ?? {
      dot: 'bg-muted-foreground',
      text: 'text-muted-foreground',
      label: (agent as any)?.status || st('sweep.weldchat.agentProfilePanel.statusUnknown'),
    };
  const statusLabel = statusLabels[(agent as any)?.status] ?? statusConfig.label;

  const enabledTools = ((agent as any)?.enabledTools as string[] | undefined) ?? [];
  const recentRuns = ((agent as any)?.recentRuns as any[] | undefined) ?? [];

  return (
    <div
      className={cn(
        'fixed bg-background z-50 flex flex-col',
        'border-l border-border',
        'inset-0',
        'md:inset-auto md:right-0 md:top-[60px] md:bottom-0',
        !skipAnimation && 'animate-in slide-in-from-right fade-in-50 duration-300',
      )}
      style={{ width: PANEL_WIDTH }}
    >
      {/* Header — icon + identity on the left, close button on the right.
          Height + padding match TeamMemberDetailsPanel so both panels feel
          like the same surface when you swap between them. */}
      <div className="group/header flex items-center justify-between px-3 md:px-4 py-[13px] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="relative flex-shrink-0">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-base">
              {(agent as any)?.icon || <Bot className="h-4 w-4 text-muted-foreground" />}
            </div>
          </div>
          <div className="flex flex-col min-w-0 leading-tight">
            <h1 className="text-[15px] font-medium text-foreground truncate max-w-[260px]">
              {(agent as any)?.name || st('sweep.weldchat.agentProfilePanel.defaultAgentName')}
            </h1>
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <span className={cn('h-1.5 w-1.5 rounded-full', statusConfig.dot)} />
              <span>{statusLabel}</span>
              <span>·</span>
              <span>{t.weldchat.agentProfilePanel.agent}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          <Link
            to="/agents/$id"
            params={{ id: agentId }}
            onClick={onClose}
            className="p-1.5 hover:bg-muted rounded-md transition-colors"
            title={t.weldchat.agentProfilePanel.openAgentSettings}
          >
            <ExternalLink className="h-4 w-4 text-gray-500" />
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="p-1.5 hover:bg-muted rounded-md transition-colors"
            onClick={onClose}
            title={t.weldchat.agentProfilePanel.close}
          >
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        </div>
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t.weldchat.agentProfilePanel.loading}</span>
        </div>
      ) : !agent ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
          {t.weldchat.agentProfilePanel.agentNotFound}
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="px-4 py-5 space-y-6">
            {(agent as any).description && (
              <section>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                  {t.weldchat.agentProfilePanel.about}
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {(agent as any).description}
                </p>
              </section>
            )}

            <section className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border p-3">
                <div className="text-lg font-semibold">{(agent as any).totalRuns ?? 0}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.weldchat.agentProfilePanel.runs}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                  {(agent as any).successfulRuns ?? 0}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.weldchat.agentProfilePanel.ok}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-lg font-semibold text-red-600 dark:text-red-400">
                  {(agent as any).failedRuns ?? 0}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.weldchat.agentProfilePanel.failed}</div>
              </div>
            </section>

            {enabledTools.length > 0 && (
              <section>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  {t.weldchat.agentProfilePanel.tools} ({enabledTools.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {enabledTools.map((tool: string) => (
                    <Badge key={tool} variant="secondary" className="text-[11px] font-mono font-normal">
                      {tool}
                    </Badge>
                  ))}
                </div>
              </section>
            )}

            {recentRuns.length > 0 && (
              <section>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  {t.weldchat.agentProfilePanel.recentRuns}
                </p>
                <div className="space-y-1.5">
                  {recentRuns.slice(0, 8).map((run: any) => {
                    const cfg = RUN_STATUS_ICON[run.status] ?? RUN_STATUS_ICON.failed;
                    const Icon = cfg.icon;
                    const runLabel = runStatusLabels[run.status] ?? cfg.label;
                    return (
                      <div key={run.id} className="flex items-center gap-2 text-xs">
                        <Icon className={cn('h-3.5 w-3.5 shrink-0', cfg.className)} />
                        <span className="flex-1 truncate">
                          {run.result?.summary ?? run.triggerType ?? runLabel}
                        </span>
                        <span className="text-muted-foreground text-[10px] shrink-0">
                          {formatDuration(run.durationMs)}
                        </span>
                        <span className="text-muted-foreground text-[10px] shrink-0">
                          {formatRelative(run.startedAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
