import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { CallControlsBar as SharedCallControlsBar } from '@/components/call';

export function CallControlsBar({ onToggleEffects, effectsOpen }: { onToggleEffects?: () => void; effectsOpen?: boolean }) {
  const {
    isMuted, isVideoOff, isScreenSharing, handRaised, viewMode,
    toggleMute, toggleVideo, startScreenShare, stopScreenShare, endCall, toggleHandRaise, setViewMode,
    meeting, backgroundType,
  } = useWeldChatCall();

  return (
    <SharedCallControlsBar
      meeting={meeting}
      isMuted={isMuted}
      isVideoOff={isVideoOff}
      isScreenSharing={isScreenSharing}
      handRaised={handRaised}
      viewMode={viewMode}
      toggleMute={toggleMute}
      toggleVideo={toggleVideo}
      startScreenShare={startScreenShare}
      stopScreenShare={stopScreenShare}
      toggleHandRaise={toggleHandRaise}
      setViewMode={setViewMode}
      onLeave={endCall}
      onToggleEffects={onToggleEffects}
      effectsOpen={effectsOpen}
      backgroundType={backgroundType}
    />
  );
}
