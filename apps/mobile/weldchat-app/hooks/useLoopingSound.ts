/**
 * Plays a bundled sound on a loop for as long as `active` is true — used for the
 * call ringtone (incoming) and ringback "calling…" tone (outgoing). Loads the
 * asset lazily when it first becomes active and tears the player down (stop +
 * release) the moment it goes inactive or the component unmounts.
 */
import { useEffect, useRef } from 'react';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

export function useLoopingSound(active: boolean, source: number) {
  const playerRef = useRef<AudioPlayer | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (active) {
      (async () => {
        try {
          // Ring through the speaker even with the ringer switch off, and mix so
          // we don't fight the WebRTC audio session once the call connects.
          await setAudioModeAsync({
            playsInSilentMode: true,
            allowsRecording: false,
            interruptionMode: 'mixWithOthers',
          });
          const player = createAudioPlayer(source);
          player.loop = true;
          if (cancelled) {
            player.release();
            return;
          }
          playerRef.current = player;
          player.play();
        } catch {
          // Best effort — never let a missing audio route break the call flow.
        }
      })();
    }

    return () => {
      cancelled = true;
      const player = playerRef.current;
      playerRef.current = null;
      if (player) {
        try {
          player.pause();
        } catch {
          // ignore
        }
        player.release();
      }
    };
  }, [active, source]);
}
