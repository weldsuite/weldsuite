/**
 * Plays a bundled sound on a loop for as long as `active` is true — used for the
 * call ringtone (incoming) and ringback "calling…" tone (outgoing). Loads the
 * asset lazily when it first becomes active and tears the player down (stop +
 * unload) the moment it goes inactive or the component unmounts.
 */
import { useEffect, useRef } from 'react';
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';

export function useLoopingSound(active: boolean, source: number) {
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (active) {
      (async () => {
        try {
          // Ring through the speaker even with the ringer switch off, and mix so
          // we don't fight the WebRTC audio session once the call connects.
          await Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            allowsRecordingIOS: false,
            interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
            interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
            shouldDuckAndroid: true,
          });
          const { sound } = await Audio.Sound.createAsync(source, { isLooping: true, volume: 1.0 });
          if (cancelled) {
            await sound.unloadAsync();
            return;
          }
          soundRef.current = sound;
          await sound.playAsync();
        } catch {
          // Best effort — never let a missing audio route break the call flow.
        }
      })();
    }

    return () => {
      cancelled = true;
      const s = soundRef.current;
      soundRef.current = null;
      if (s) {
        s.stopAsync()
          .catch(() => {})
          .finally(() => s.unloadAsync().catch(() => {}));
      }
    };
  }, [active, source]);
}
