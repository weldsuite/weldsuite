import type { ReactNode } from 'react';
import { useUser } from '@/lib/auth';
import { ChevronLeft, Mic, MicOff } from 'lucide-react';
import { Separator } from '@weldsuite/ui/components/separator';
import {
  MeetingSidePanel,
  MeetingToolsPanel,
  PersonAvatar,
  getInitials,
  toolTitle,
  type MeetingToolKey,
  type MeetingToolsController,
} from '@weldsuite/weldmeet-ui';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { formatDuration, formatPhoneDisplay, type CallStateValue } from '@/components/weldcrm/calls/call-dialing';

// The contents of the call screen's Details and People panels, laid out like
// WeldMeet's Meeting details and People panels (see @weldsuite/weldmeet-ui).

export type CallPanelKind = 'info' | 'people' | 'tools';

/** A labelled value, as in Meeting details. */
function DetailField({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function CallDetailsPanel({ callState, title }: Readonly<{ callState: CallStateValue; title: string }>) {
  const t = getTranslations('weldmeet');
  const { columns, filters } = t.weldcall.callHistory;
  const toNumber = formatPhoneDisplay(callState.toNumber);

  return (
    <div data-testid="weldcall-details-panel" className="p-5 space-y-5">
      <div className="space-y-1">
        <h3 className="text-base font-semibold leading-snug">{title}</h3>
      </div>

      <Separator />

      <DetailField label={columns.from}>
        <span className="tabular-nums">{formatPhoneDisplay(callState.fromNumber)}</span>
      </DetailField>
      <DetailField label={columns.to}>
        {callState.contactName ? (
          <>
            <p>{callState.contactName}</p>
            <p className="tabular-nums text-muted-foreground">{toNumber}</p>
          </>
        ) : (
          <span className="tabular-nums">{toNumber}</span>
        )}
      </DetailField>
      <DetailField label={t.inCall.header.duration}>
        <span className="font-mono tabular-nums">{formatDuration(callState.duration)}</span>
      </DetailField>
      <DetailField label={columns.recording}>
        {callState.isRecording ? filters.recorded : filters.notRecorded}
      </DetailField>
    </div>
  );
}

/** The mic state on the right of a row, as in the meeting's People panel. */
function MicBadge({ enabled }: Readonly<{ enabled: boolean }>) {
  return (
    <div
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-[8px]',
        enabled ? 'bg-muted text-muted-foreground' : 'bg-red-500/10 text-red-400',
      )}
    >
      {enabled ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
    </div>
  );
}

interface PersonRowProps {
  name: string;
  detail?: string;
  initials: string;
  picture?: string;
  colorSeed: string;
  /** Green presence dot: this person is on the call. */
  inCall: boolean;
  /** Mic state badge; only known for your own side of a phone call. */
  micEnabled?: boolean;
}

function PersonRow({ name, detail, initials, picture, colorSeed, inCall, micEnabled }: Readonly<PersonRowProps>) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-1 -mx-1 rounded-md">
      <div className="relative">
        <PersonAvatar
          initials={initials}
          picture={picture}
          colorSeed={colorSeed}
          className="h-7 w-7 !rounded-[8px]"
          innerClassName="text-[10px] !rounded-[8px]"
        />
        {inCall && (
          <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background bg-emerald-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium leading-tight truncate">{name}</p>
        {detail && <p className="mt-0.5 text-xs leading-tight tabular-nums text-muted-foreground truncate">{detail}</p>}
      </div>
      {micEnabled !== undefined && <MicBadge enabled={micEnabled} />}
    </div>
  );
}

export function CallPeoplePanel({ callState }: Readonly<{ callState: CallStateValue }>) {
  const { user } = useUser();
  const tn = getTranslations('weldmeet').weldcall.newCall;
  const isConnected = callState.status === 'connected';
  const { contactName } = callState;
  const toNumber = formatPhoneDisplay(callState.toNumber);

  return (
    <div data-testid="weldcall-people-panel" className="py-4">
      <div className="px-5 pb-1">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
          {tn.inThisCall.replace('{count}', String(isConnected ? 2 : 1))}
        </p>
      </div>
      <div className="px-4">
        <PersonRow
          name={tn.you}
          detail={formatPhoneDisplay(callState.fromNumber)}
          initials={getInitials(user?.fullName || tn.you)}
          picture={user?.imageUrl}
          colorSeed={user?.id ?? 'self'}
          inCall
          micEnabled={!callState.isMuted}
        />
        <PersonRow
          name={contactName || toNumber}
          detail={contactName ? toNumber : undefined}
          initials={contactName ? getInitials(contactName) : '#'}
          colorSeed={callState.toNumber}
          inCall={isConnected}
        />
      </div>
    </div>
  );
}

/** Only the tools that work without a meeting to share them with. */
const CALL_TOOLS: MeetingToolKey[] = ['timer'];

/** The panel title, or while a tool is open, its name and a way back to the list (as in a meeting). */
function ToolsPanelTitle({ tools, title }: Readonly<{ tools: MeetingToolsController | null; title: string }>) {
  if (!tools?.activeTool) return <span className="text-sm font-semibold">{title}</span>;
  return (
    <div className="flex min-w-0 items-center gap-1.5 -ml-1.5">
      <button
        type="button"
        onClick={() => tools.setActiveTool(null)}
        aria-label={tools.labels.back}
        title={tools.labels.back}
        className="p-1.5 max-md:p-2.5 rounded-md hover:bg-muted transition-colors"
      >
        <ChevronLeft className="h-4 w-4 text-muted-foreground" />
      </button>
      <span className="truncate text-sm font-semibold">{toolTitle(tools.activeTool, tools.labels)}</span>
    </div>
  );
}

interface CallSidePanelProps {
  panel: CallPanelKind;
  callState: CallStateValue;
  callTitle: string;
  tools: MeetingToolsController | null;
  onClose: () => void;
}

/** The meeting's right-hand dock, opened from the call header. */
export function CallSidePanel({ panel, callState, callTitle, tools, onClose }: Readonly<CallSidePanelProps>) {
  const t = getTranslations('weldmeet');
  const header = t.inCall.header;

  if (panel === 'tools') {
    return (
      <MeetingSidePanel onClose={onClose} header={<ToolsPanelTitle tools={tools} title={header.tools} />}>
        <MeetingToolsPanel tools={tools} onlyTools={CALL_TOOLS} showRecord={false} showToolHeader={false} />
      </MeetingSidePanel>
    );
  }

  return (
    <MeetingSidePanel
      onClose={onClose}
      header={<span className="text-sm font-semibold">{panel === 'info' ? t.weldcall.callDetail.callDetails : header.people}</span>}
    >
      {panel === 'info' ? <CallDetailsPanel callState={callState} title={callTitle} /> : <CallPeoplePanel callState={callState} />}
    </MeetingSidePanel>
  );
}
