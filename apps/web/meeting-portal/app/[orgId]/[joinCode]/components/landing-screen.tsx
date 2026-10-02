'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormRegister } from 'react-hook-form';
import { Loader2, Mail, ShieldAlert, User } from 'lucide-react';
import { useEffect, useState, type CSSProperties, type Ref } from 'react';

import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@weldsuite/ui/lib/utils';
import { ParticipantAvatar, ParticipantNameTag } from '@weldsuite/weldmeet-ui';

import { PREVIEW_DARK_BG, type PersonTheme } from '@/lib/constants';
import { clearGuestIdentity, readGuestIdentity } from '@/lib/guest-identity';
import { guestJoinFormSchema, type GuestJoinFormInput, type MeetingInfo } from '@/lib/schemas';

import { PrejoinMediaControls, type PermState } from './prejoin-media-controls';
import { useIsMobile } from './use-is-mobile';

interface LandingScreenProps {
  joinCode: string;
  meetingInfo: MeetingInfo | null;
  joining: boolean;
  submitError: string | null;
  personTheme: PersonTheme;
  videoRef: Ref<HTMLVideoElement>;

  previewStream: MediaStream | null;
  previewAudioEnabled: boolean;
  previewVideoEnabled: boolean;
  audioPermission: PermState;
  videoPermission: PermState;
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  selectedAudioInput: string;
  selectedVideoInput: string;

  togglePreviewAudio: () => void;
  togglePreviewVideo: () => void;
  changeAudioDevice: (deviceId: string) => void;
  changeVideoDevice: (deviceId: string) => void;
  requestPermissions: () => void;
  onSubmit: (values: GuestJoinFormInput) => void | Promise<void>;
}

const EASE = 'cubic-bezier(0.25, 0.1, 0.25, 1)';

function getInitials(name: string | undefined, placeholder: string): string {
  if (!name) return placeholder.charAt(0).toUpperCase();
  return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
}

function getFormStyle(isMobile: boolean, joining: boolean): CSSProperties | undefined {
  if (isMobile) return undefined;
  return {
    maxWidth: joining ? 850 : 1100,
    gap: joining ? 0 : 40,
    transition: 'max-width 400ms ' + EASE + ', gap 400ms ' + EASE,
  };
}

function getPreviewColumnStyle(isMobile: boolean, joining: boolean): CSSProperties | undefined {
  if (isMobile) return undefined;
  return { flex: joining ? '1 1 100%' : '1 1 0%', transition: 'flex 400ms ' + EASE };
}

function getFormColumnStyle(isMobile: boolean, joining: boolean): CSSProperties | undefined {
  if (isMobile) return undefined;
  return {
    width: joining ? 0 : 320,
    opacity: joining ? 0 : 1,
    transition: 'width 400ms ' + EASE + ', opacity 300ms ease',
  };
}

function getFormColumnMobileClass(isMobile: boolean, joining: boolean): string {
  if (!isMobile) return '';
  return joining ? 'hidden' : 'w-full';
}

function isPermissionUndecided(state: PermState): boolean {
  return state === 'prompt' || state === 'unknown';
}

function isPermissionPending(
  previewStream: MediaStream | null,
  audioPermission: PermState,
  videoPermission: PermState,
): boolean {
  if (previewStream) return false;
  if (audioPermission === 'denied' || videoPermission === 'denied') return false;
  return isPermissionUndecided(audioPermission) || isPermissionUndecided(videoPermission);
}

function ConnectingOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0b]/70 backdrop-blur-sm z-20">
      <div className="flex items-center gap-2.5">
        <Loader2 className="h-5 w-5 animate-spin text-[#82828a]" />
        <span className="text-[#82828a] text-sm">Connecting...</span>
      </div>
    </div>
  );
}

function PermissionPrompt({ onAllow }: Readonly<{ onAllow: () => void }>) {
  return (
    <div className="absolute top-12 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-gray-900/80 backdrop-blur-sm ring-1 ring-white/20 rounded-lg px-3 py-2 text-[12px] text-white/90 max-w-[90%]">
      <ShieldAlert className="h-4 w-4 flex-shrink-0 text-white/70" />
      <span className="leading-tight">Camera and microphone access required.</span>
      <button
        type="button"
        onClick={onAllow}
        className="ml-1 text-[12px] font-medium text-white underline underline-offset-2 hover:text-white/80"
      >
        Allow
      </button>
    </div>
  );
}

type PreviewPaneProps = Pick<
  LandingScreenProps,
  | 'joining'
  | 'personTheme'
  | 'videoRef'
  | 'previewStream'
  | 'previewAudioEnabled'
  | 'previewVideoEnabled'
  | 'audioPermission'
  | 'videoPermission'
  | 'audioInputs'
  | 'videoInputs'
  | 'selectedAudioInput'
  | 'selectedVideoInput'
  | 'togglePreviewAudio'
  | 'togglePreviewVideo'
  | 'changeAudioDevice'
  | 'changeVideoDevice'
  | 'requestPermissions'
> & {
  displayName: string;
  initials: string;
};

function PreviewVideoArea({
  joining,
  personTheme,
  videoRef,
  previewStream,
  previewVideoEnabled,
  initials,
}: Readonly<
  Pick<
    PreviewPaneProps,
    'joining' | 'personTheme' | 'videoRef' | 'previewStream' | 'previewVideoEnabled' | 'initials'
  >
>) {
  if (previewVideoEnabled && previewStream) {
    return <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover -scale-x-100" />;
  }
  if (joining) return null;
  return <ParticipantAvatar initials={initials} color={personTheme.avatar} />;
}

function PreviewPane(props: Readonly<PreviewPaneProps>) {
  const {
    joining,
    personTheme,
    previewStream,
    previewAudioEnabled,
    previewVideoEnabled,
    audioPermission,
    videoPermission,
    requestPermissions,
    displayName,
  } = props;
  const showColoredPreviewTile = !previewVideoEnabled || !previewStream;
  const showPermissionPrompt =
    !joining && isPermissionPending(previewStream, audioPermission, videoPermission);

  return (
    <div
      className="relative w-full aspect-[3/2] ring-1 ring-white/[0.06] rounded-2xl overflow-hidden flex items-center justify-center transition-colors duration-300 [container-type:size]"
      style={{ backgroundColor: showColoredPreviewTile ? personTheme.tile : PREVIEW_DARK_BG }}
    >
      <PreviewVideoArea {...props} />

      <ParticipantNameTag name={displayName} audioEnabled={previewAudioEnabled} />

      {joining && <ConnectingOverlay />}

      {showPermissionPrompt && <PermissionPrompt onAllow={requestPermissions} />}

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3">
        <PrejoinMediaControls
          previewAudioEnabled={previewAudioEnabled}
          previewVideoEnabled={previewVideoEnabled}
          audioPermission={audioPermission}
          videoPermission={videoPermission}
          audioInputs={props.audioInputs}
          videoInputs={props.videoInputs}
          selectedAudioInput={props.selectedAudioInput}
          selectedVideoInput={props.selectedVideoInput}
          togglePreviewAudio={props.togglePreviewAudio}
          togglePreviewVideo={props.togglePreviewVideo}
          changeAudioDevice={props.changeAudioDevice}
          changeVideoDevice={props.changeVideoDevice}
        />
      </div>
    </div>
  );
}

interface JoinFieldsProps {
  register: UseFormRegister<GuestJoinFormInput>;
  namePlaceholder: string;
  nameError: string | undefined;
  emailError: string | undefined;
  displayedError: string | null;
}

function JoinFields({
  register,
  namePlaceholder,
  nameError,
  emailError,
  displayedError,
}: Readonly<JoinFieldsProps>) {
  return (
    <div className="w-full mt-8 space-y-3 text-left">
      <div className="relative">
        <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          id="guest-name"
          placeholder={namePlaceholder}
          aria-invalid={nameError ? true : undefined}
          className={cn('pl-9', nameError ? 'border-destructive focus-visible:ring-destructive/50' : '')}
          {...register('name')}
        />
      </div>
      <div className="relative">
        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          id="guest-email"
          type="email"
          placeholder="Your email"
          aria-invalid={emailError ? true : undefined}
          className={cn('pl-9', emailError ? 'border-destructive focus-visible:ring-destructive/50' : '')}
          {...register('email')}
        />
      </div>
      {displayedError && (
        <p className="text-sm text-destructive">{displayedError}</p>
      )}
    </div>
  );
}

export function LandingScreen({
  joinCode,
  meetingInfo,
  joining,
  submitError,
  personTheme,
  videoRef,
  previewStream,
  previewAudioEnabled,
  previewVideoEnabled,
  audioPermission,
  videoPermission,
  audioInputs,
  videoInputs,
  selectedAudioInput,
  selectedVideoInput,
  togglePreviewAudio,
  togglePreviewVideo,
  changeAudioDevice,
  changeVideoDevice,
  requestPermissions,
  onSubmit,
}: Readonly<LandingScreenProps>) {
  const form = useForm<GuestJoinFormInput>({
    resolver: zodResolver(guestJoinFormSchema),
    mode: 'onChange',
    defaultValues: { name: '', email: '' },
  });

  const { register, handleSubmit, watch, formState, getValues, setValue, reset } = form;
  // True while the form holds details restored from a previous visit, which
  // is when the "Not you?" escape hatch is shown.
  const [prefilled, setPrefilled] = useState(false);

  // Restore the remembered name + email. Read after mount (not in
  // defaultValues) so the server and first client render match; skipped when
  // the guest has already started typing.
  useEffect(() => {
    const saved = readGuestIdentity();
    if (!saved) return;
    const current = getValues();
    if (current.name || current.email) return;
    setValue('name', saved.name, { shouldValidate: true });
    setValue('email', saved.email, { shouldValidate: true });
    setPrefilled(true);
  }, [getValues, setValue]);

  const handleNotYou = () => {
    clearGuestIdentity();
    reset({ name: '', email: '' });
    setPrefilled(false);
  };
  const watchedName = watch('name');
  const isMobile = useIsMobile();

  const namePlaceholder = 'Your name';
  const initials = getInitials(watchedName, namePlaceholder);

  const platformUrl = process.env.NEXT_PUBLIC_PLATFORM_URL || 'https://app.weldsuite.org';

  const nameError = formState.errors.name?.message;
  const emailError = formState.errors.email?.message;
  const displayedError = submitError ?? nameError ?? emailError ?? null;
  const submitDisabled = joining || !formState.isValid;

  return (
    <div className="relative flex-1 flex items-center justify-center min-h-screen bg-background">
      <div className="absolute top-6 left-6 z-10">
        {/* Inline SVG logos: next/image cannot optimise SVG without
            dangerouslyAllowSVG, so a plain img is the right call here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/weldmeet-logo-light.svg" alt="WeldMeet" className="h-5 w-auto block dark:hidden" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/weldmeet-logo-dark.svg" alt="WeldMeet" className="h-5 w-auto hidden dark:block" />
      </div>
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <Button asChild variant="ghost" className="rounded-[calc(var(--radius)-1px)] text-muted-foreground hover:text-foreground">
          <a href={`${platformUrl}/auth/register`}>Create account</a>
        </Button>
        <Button asChild variant="outline" className="rounded-[calc(var(--radius)-1px)]">
          <a href={`${platformUrl}/weldmeet/join/${joinCode}`}>Sign in</a>
        </Button>
      </div>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className={cn(
          'w-full',
          isMobile ? 'flex flex-col items-stretch gap-6 px-5 max-w-[440px]' : 'flex items-center px-8',
        )}
        style={getFormStyle(isMobile, joining)}
      >
        {/* Left — Video preview */}
        <div
          className={cn('flex flex-col gap-4', isMobile && 'w-full')}
          style={getPreviewColumnStyle(isMobile, joining)}
        >
          <PreviewPane
            joining={joining}
            personTheme={personTheme}
            videoRef={videoRef}
            previewStream={previewStream}
            previewAudioEnabled={previewAudioEnabled}
            previewVideoEnabled={previewVideoEnabled}
            audioPermission={audioPermission}
            videoPermission={videoPermission}
            audioInputs={audioInputs}
            videoInputs={videoInputs}
            selectedAudioInput={selectedAudioInput}
            selectedVideoInput={selectedVideoInput}
            togglePreviewAudio={togglePreviewAudio}
            togglePreviewVideo={togglePreviewVideo}
            changeAudioDevice={changeAudioDevice}
            changeVideoDevice={changeVideoDevice}
            requestPermissions={requestPermissions}
            displayName={watchedName || 'You'}
            initials={initials}
          />
        </div>

        {/* Right — Join form (stacks below the preview on mobile; hidden while
            connecting so the preview + overlay fill the viewport) */}
        <div
          className={cn(
            'flex flex-col items-center text-center overflow-visible',
            getFormColumnMobileClass(isMobile, joining),
          )}
          style={getFormColumnStyle(isMobile, joining)}
        >
          <h2 className="text-[24px] font-semibold tracking-tight leading-tight">
            {meetingInfo?.title || 'Join Meeting'}
          </h2>
          <ScheduleLine scheduledStart={meetingInfo?.scheduledStart} scheduledEnd={meetingInfo?.scheduledEnd} />
          <AttendeesRow meetingInfo={meetingInfo} />

          <JoinFields
            register={register}
            namePlaceholder={namePlaceholder}
            nameError={nameError}
            emailError={emailError}
            displayedError={displayedError}
          />
          {prefilled && (
            <button
              type="button"
              onClick={handleNotYou}
              className="mt-2 self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Not you?
            </button>
          )}

          <div className="w-full mt-5 flex flex-col gap-3">
            <Button
              type="submit"
              disabled={submitDisabled}
              aria-disabled={submitDisabled}
              className="w-full h-[48px] rounded-xl text-[15px] font-medium disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed"
            >
              {joining ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Join now'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Thursday, 2 October 2026 · 14:00 – 15:00" in the guest's own locale and time zone. */
function formatSchedule(start: Date, end: Date | null): string {
  const dateText = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(start);
  const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
  const startTime = timeFormat.format(start);
  if (!end) return `${dateText} · ${startTime}`;
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return `${dateText} · ${startTime} – ${timeFormat.format(end)}`;
  const endDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(end);
  return `${dateText} · ${startTime} – ${endDateTime}`;
}

function ScheduleLine({
  scheduledStart,
  scheduledEnd,
}: Readonly<{ scheduledStart?: string | null; scheduledEnd?: string | null }>) {
  // The guest's time zone is only known in the browser, so format after mount;
  // rendering during SSR would mismatch on hydration.
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const start = parseDate(scheduledStart);
    setText(start ? formatSchedule(start, parseDate(scheduledEnd)) : null);
  }, [scheduledStart, scheduledEnd]);

  if (!text) return null;
  return <p className="mt-1.5 text-[13px] text-muted-foreground">{text}</p>;
}

type AttendeePerson = { name: string; role: string; avatar?: string };

function getAttendeePeople(meetingInfo: MeetingInfo | null): AttendeePerson[] {
  if (meetingInfo?.attendees?.length) return meetingInfo.attendees;
  if (meetingInfo?.organizerName) return [{ name: meetingInfo.organizerName, role: 'organizer' }];
  return [];
}

function getAttendeesLabel(people: AttendeePerson[]): string {
  if (people.length === 1) return people[0]!.name;
  if (people.length <= 3) return people.map(a => a.name).join(', ');
  return `${people.slice(0, 2).map(a => a.name).join(', ')} and ${people.length - 2} more`;
}

/** Stable keys for the avatar stack: name + role, suffixed when the pair repeats. */
function keyAttendees(people: AttendeePerson[]): Array<{ key: string; person: AttendeePerson }> {
  const seen = new Map<string, number>();
  return people.map((person) => {
    const base = `${person.role}:${person.name}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: `${base}:${count}`, person };
  });
}

function AttendeesRow({ meetingInfo }: Readonly<{ meetingInfo: MeetingInfo | null }>) {
  const people = getAttendeePeople(meetingInfo);
  if (people.length === 0) return null;

  return (
    <div className="flex items-center gap-2 mt-3">
      <div className="flex -space-x-1.5">
        {keyAttendees(people.slice(0, 3)).map(({ key, person: a }) => (
          <div
            key={key}
            className="w-[22px] h-[22px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center ring-2 ring-white dark:ring-background text-[10px] font-medium text-gray-600 dark:text-muted-foreground overflow-hidden"
          >
            {'avatar' in a && a.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element -- avatar host is not known ahead of time; next/image needs an images.remotePatterns allowlist
              <img src={a.avatar} alt="" className="w-full h-full object-cover" />
            ) : (
              a.name?.charAt(0)?.toUpperCase() ?? '?'
            )}
          </div>
        ))}
        {people.length > 3 && (
          <div className="w-[22px] h-[22px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center ring-2 ring-white dark:ring-background text-[11px] font-semibold text-gray-600 dark:text-muted-foreground">
            +{people.length - 3}
          </div>
        )}
      </div>
      <span className="text-[13px] text-muted-foreground">
        {getAttendeesLabel(people)}
      </span>
    </div>
  );
}
