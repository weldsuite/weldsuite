import {
  Shield, Mic, VideoIcon, Hand, MessageSquare, ImageIcon, MonitorOff,
  Circle, DoorOpen, Users,
} from 'lucide-react';
import { Switch } from '@weldsuite/ui/components/switch';

/**
 * Host-control policy values for an in-progress or scheduled meeting. Mirrors
 * the `meetings` table columns and the `HostControls` interface in
 * `@weldsuite/core-api-client/schemas/weldmeet`. We don't import it here to
 * keep `weldmeet-ui` free of core-api-client coupling; the platform passes
 * the shape down directly.
 *
 * NB: Several fields below (allowAnnotations, enableCaptions, noiseCancellation,
 * lockAfterStart, autoEndOnInactivity, accessType, allowThirdPartyAccess) are
 * NOT rendered in the panel — the underlying DB columns and broadcast path
 * remain so callers that read these fields elsewhere keep working. They were
 * deliberately removed from the UI on the request that landed in this commit.
 */
export interface HostControlsValue {
  hostManagement: boolean;
  allowScreenShare: boolean;
  allowMicrophone: boolean;
  allowVideo: boolean;
  allowHandRaise: boolean;
  allowReactions: boolean;
  allowAnnotations: boolean;
  allowVirtualBackgrounds: boolean;
  allowParticipantRecord: boolean;
  allowThirdPartyAccess: boolean;
  noiseCancellation: boolean;
  autoRecord: boolean;
  enableCaptions: boolean;
  waitingRoom: boolean;
  hostMustJoinFirst: boolean;
  lockAfterStart: boolean;
  autoEndOnInactivity: boolean;
  accessType: 'workspace' | 'invited_only' | 'anyone_with_link';
}

export interface HostControlsPanelProps {
  /** RTK meeting handle. Used for immediate enforcement on toggle-off
   *  (disableAllAudio/disableAllVideo). Optional — when null the inline
   *  enforcement is skipped and only the policy is persisted. */
  meeting?: any;
  /** Current host-control values. Always passed (no internal state). */
  controls: HostControlsValue;
  /** Called when the host flips a toggle. Caller is responsible for
   *  persisting via PATCH + broadcasting via RTK. */
  onChange: (patch: Partial<HostControlsValue>) => void;
  /** When true, switches are visually rendered but not interactive — used on
   *  the portal where a non-organizer might see the panel. */
  readOnly?: boolean;
}

const SETTING_SWITCH_CLASS = [
  '!h-[18px] !w-8 !shadow-none',
  '[&_[data-slot=switch-thumb]]:!size-[10px]',
  '[&_[data-slot=switch-thumb]]:!rounded-[4.5px]',
  '[&_[data-slot=switch-thumb]]:!bg-white',
  '[&_[data-slot=switch-thumb][data-state=checked]]:!translate-x-[16px]',
  '[&_[data-slot=switch-thumb][data-state=unchecked]]:!translate-x-[4px]',
].join(' ');

export function HostControlsPanel({ meeting, controls, onChange, readOnly }: HostControlsPanelProps) {
  const SettingRow = ({ icon: Icon, label, description, checked, onCheckedChange, disabled }: {
    icon: any; label: string; description?: string; checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean;
  }) => (
    <div className="flex items-center gap-3 py-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted border">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium leading-tight">{label}</p>
        {description && <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{description}</p>}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={readOnly ? () => {} : onCheckedChange}
        disabled={disabled || readOnly}
        className={SETTING_SWITCH_CLASS}
      />
    </div>
  );

  const hostManaged = controls.hostManagement;

  return (
    <div className="py-2">
      <div className="px-4 mb-1">
        <SettingRow
          icon={Shield}
          label="Host management"
          description="Restrict what participants can enable in this meeting."
          checked={controls.hostManagement}
          onCheckedChange={(v) => onChange({ hostManagement: v })}
        />
      </div>

      <div className="px-5 py-2"><div className="h-px bg-border" /></div>

      <div className="px-5 pt-2 pb-1"><p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Participant permissions</p></div>
      <div className="px-4">
        <SettingRow
          icon={MonitorOff}
          label="Share their screen"
          checked={controls.allowScreenShare}
          onCheckedChange={(v) => onChange({ allowScreenShare: v })}
          disabled={!hostManaged}
        />
        <SettingRow
          icon={Mic}
          label="Turn on their microphone"
          description="Mutes all when turned off."
          checked={controls.allowMicrophone}
          onCheckedChange={(v) => {
            onChange({ allowMicrophone: v });
            if (!v) { try { meeting?.participants?.disableAllAudio?.(false); } catch { /* ignore */ } }
          }}
          disabled={!hostManaged}
        />
        <SettingRow
          icon={VideoIcon}
          label="Turn on their video"
          description="Disables all cameras when turned off."
          checked={controls.allowVideo}
          onCheckedChange={(v) => {
            onChange({ allowVideo: v });
            if (!v) { try { meeting?.participants?.disableAllVideo?.(); } catch { /* ignore */ } }
          }}
          disabled={!hostManaged}
        />
        <SettingRow
          icon={Hand}
          label="Raise hand"
          checked={controls.allowHandRaise}
          onCheckedChange={(v) => onChange({ allowHandRaise: v })}
          disabled={!hostManaged}
        />
        <SettingRow
          icon={MessageSquare}
          label="Send reactions"
          checked={controls.allowReactions}
          onCheckedChange={(v) => onChange({ allowReactions: v })}
          disabled={!hostManaged}
        />
        <SettingRow
          icon={ImageIcon}
          label="Use virtual backgrounds"
          checked={controls.allowVirtualBackgrounds}
          onCheckedChange={(v) => onChange({ allowVirtualBackgrounds: v })}
          disabled={!hostManaged}
        />
      </div>

      <div className="px-5 py-2"><div className="h-px bg-border" /></div>

      <div className="px-5 pt-2 pb-1"><p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Recording</p></div>
      <div className="px-4">
        <SettingRow
          icon={Circle}
          label="Auto-record meeting"
          description="Start recording when the meeting begins."
          checked={controls.autoRecord}
          onCheckedChange={(v) => onChange({ autoRecord: v })}
        />
        <SettingRow
          icon={Circle}
          label="Allow participants to record"
          description="Only the host can record when off."
          checked={controls.allowParticipantRecord}
          onCheckedChange={(v) => onChange({ allowParticipantRecord: v })}
        />
      </div>

      <div className="px-5 py-2"><div className="h-px bg-border" /></div>

      <div className="px-5 pt-2 pb-1"><p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Meeting access</p></div>
      <div className="px-4 pb-2">
        <SettingRow
          icon={DoorOpen}
          label="Waiting room"
          description="Participants must be admitted before joining."
          checked={controls.waitingRoom}
          onCheckedChange={(v) => onChange({ waitingRoom: v })}
        />
        <SettingRow
          icon={Users}
          label="Host must join first"
          checked={controls.hostMustJoinFirst}
          onCheckedChange={(v) => onChange({ hostMustJoinFirst: v })}
        />
      </div>
    </div>
  );
}
