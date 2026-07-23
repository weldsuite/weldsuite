'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Loader2, Mail, ShieldAlert, User } from 'lucide-react';
import type { Ref } from 'react';

import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@weldsuite/ui/lib/utils';
import { ParticipantAvatar, ParticipantNameTag } from '@weldsuite/weldmeet-ui';

import { PREVIEW_DARK_BG, type PersonTheme } from '@/lib/constants';
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
}: LandingScreenProps) {
  const form = useForm<GuestJoinFormInput>({
    resolver: zodResolver(guestJoinFormSchema),
    mode: 'onChange',
    defaultValues: { name: '', email: '' },
  });

  const { register, handleSubmit, watch, formState } = form;
  const watchedName = watch('name');
  const isMobile = useIsMobile();

  const namePlaceholder = 'Your name';
  const initials = watchedName
    ? watchedName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : namePlaceholder.charAt(0).toUpperCase();

  const platformUrl = process.env.NEXT_PUBLIC_PLATFORM_URL || 'https://app.weldsuite.org';
  const showColoredPreviewTile = !previewVideoEnabled || !previewStream;
  const permissionDenied = audioPermission === 'denied' || videoPermission === 'denied';
  const permissionPending = !previewStream && !permissionDenied && (
    audioPermission === 'prompt' || videoPermission === 'prompt' ||
    audioPermission === 'unknown' || videoPermission === 'unknown'
  );

  const nameError = formState.errors.name?.message;
  const emailError = formState.errors.email?.message;
  const displayedError = submitError ?? nameError ?? emailError ?? null;

  return (
    <div className="relative flex-1 flex items-center justify-center min-h-screen bg-background">
      <div className="absolute top-6 left-6 z-10">
        <img src="/weldmeet-logo-light.svg" alt="WeldMeet" className="h-5 w-auto block dark:hidden" />
        <img src="/weldmeet-logo-dark.svg" alt="WeldMeet" className="h-5 w-auto hidden dark:block" />
      </div>
      <Button asChild variant="outline" className="absolute top-4 right-4 z-10 rounded-[calc(var(--radius)-1px)]">
        <a href={`${platformUrl}/weldmeet/join/${joinCode}`}>Sign in</a>
      </Button>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className={cn(
          'w-full',
          isMobile ? 'flex flex-col items-stretch gap-6 px-5 max-w-[440px]' : 'flex items-center px-8',
        )}
        style={
          isMobile
            ? undefined
            : {
                maxWidth: joining ? 850 : 1100,
                gap: joining ? 0 : 40,
                transition:
                  'max-width 400ms cubic-bezier(0.25, 0.1, 0.25, 1), gap 400ms cubic-bezier(0.25, 0.1, 0.25, 1)',
              }
        }
      >
        {/* Left — Video preview */}
        <div
          className={cn('flex flex-col gap-4', isMobile && 'w-full')}
          style={
            isMobile
              ? undefined
              : { flex: joining ? '1 1 100%' : '1 1 0%', transition: 'flex 400ms cubic-bezier(0.25, 0.1, 0.25, 1)' }
          }
        >
          <div
            className="relative w-full aspect-[3/2] ring-1 ring-white/[0.06] rounded-2xl overflow-hidden flex items-center justify-center transition-colors duration-300 [container-type:size]"
            style={{ backgroundColor: showColoredPreviewTile ? personTheme.tile : PREVIEW_DARK_BG }}
          >
            {previewVideoEnabled && previewStream ? (
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover -scale-x-100" />
            ) : !joining ? (
              <ParticipantAvatar initials={initials} color={personTheme.avatar} />
            ) : null}

            <ParticipantNameTag
              name={watchedName || 'You'}
              audioEnabled={previewAudioEnabled}
            />

            {joining && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0b]/70 backdrop-blur-sm z-20">
                <div className="flex items-center gap-2.5">
                  <Loader2 className="h-5 w-5 animate-spin text-[#82828a]" />
                  <span className="text-[#82828a] text-sm">Connecting...</span>
                </div>
              </div>
            )}

            {!joining && !permissionDenied && permissionPending && (
              <div className="absolute top-12 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-gray-900/80 backdrop-blur-sm ring-1 ring-white/20 rounded-lg px-3 py-2 text-[12px] text-white/90 max-w-[90%]">
                <ShieldAlert className="h-4 w-4 flex-shrink-0 text-white/70" />
                <span className="leading-tight">Camera and microphone access required.</span>
                <button
                  type="button"
                  onClick={requestPermissions}
                  className="ml-1 text-[12px] font-medium text-white underline underline-offset-2 hover:text-white/80"
                >
                  Allow
                </button>
              </div>
            )}

            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3">
              <PrejoinMediaControls
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
              />
            </div>
          </div>
        </div>

        {/* Right — Join form (stacks below the preview on mobile; hidden while
            connecting so the preview + overlay fill the viewport) */}
        <div
          className={cn(
            'flex flex-col items-center text-center overflow-visible',
            isMobile && (joining ? 'hidden' : 'w-full'),
          )}
          style={
            isMobile
              ? undefined
              : {
                  width: joining ? 0 : 320,
                  opacity: joining ? 0 : 1,
                  transition: 'width 400ms cubic-bezier(0.25, 0.1, 0.25, 1), opacity 300ms ease',
                }
          }
        >
          <h2 className="text-[24px] font-semibold tracking-tight leading-tight">
            {meetingInfo?.title || 'Join Meeting'}
          </h2>
          <AttendeesRow meetingInfo={meetingInfo} />

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

          <div className="w-full mt-5 flex flex-col gap-3">
            <Button
              type="submit"
              disabled={joining || !formState.isValid}
              aria-disabled={joining || !formState.isValid}
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

function AttendeesRow({ meetingInfo }: { meetingInfo: MeetingInfo | null }) {
  const people = meetingInfo?.attendees?.length
    ? meetingInfo.attendees
    : meetingInfo?.organizerName
      ? [{ name: meetingInfo.organizerName, role: 'organizer' }]
      : [];
  if (people.length === 0) return null;

  return (
    <div className="flex items-center gap-2 mt-3">
      <div className="flex -space-x-1.5">
        {people.slice(0, 3).map((a, i) => (
          <div
            key={i}
            className="w-[22px] h-[22px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center ring-2 ring-white dark:ring-background text-[10px] font-medium text-gray-600 dark:text-muted-foreground overflow-hidden"
          >
            {'avatar' in a && a.avatar ? (
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
        {people.length === 1
          ? people[0]!.name
          : people.length <= 3
            ? people.map(a => a.name).join(', ')
            : `${people.slice(0, 2).map(a => a.name).join(', ')} and ${people.length - 2} more`
        }
      </span>
    </div>
  );
}
