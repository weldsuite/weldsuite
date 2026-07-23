import { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Pressable, GestureResponderEvent } from 'react-native';
import { Audio } from 'expo-av';
import { Play, Pause } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';

interface AudioPlayerProps {
  uri: string;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Deterministic pseudo-random bar heights seeded by URI hash so the
 *  same voice message renders the same waveform every time. */
function generateBars(seed: number, count: number): number[] {
  let s = seed >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // xorshift32
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const v = ((s >>> 0) % 1000) / 1000;
    // Bias toward middle heights with an envelope so the wave looks "speech-like".
    const env = 0.5 + 0.5 * Math.sin((i / count) * Math.PI);
    out.push(0.25 + 0.75 * v * env);
  }
  return out;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

const BAR_COUNT = 33;

// Module-level registry: only one AudioPlayer may play at a time. When a
// player starts, it pauses whatever was playing before by calling the
// previously-registered pause callback.
let activePauseFn: (() => void) | null = null;
function setActivePlayer(pause: () => void) {
  if (activePauseFn && activePauseFn !== pause) {
    activePauseFn();
  }
  activePauseFn = pause;
}
function clearActivePlayer(pause: () => void) {
  if (activePauseFn === pause) activePauseFn = null;
}

export function AudioPlayer({ uri }: AudioPlayerProps) {
  const { colors } = useTheme();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const soundRef = useRef<Audio.Sound | null>(null);
  const waveformRef = useRef<View | null>(null);
  const waveformLayout = useRef<{ x: number; width: number } | null>(null);
  // Anchor used to interpolate the playback position between expo-av status
  // ticks. expo-av reports `positionMillis` ~every 100–500ms, which makes the
  // waveform fill jump in chunks. We capture (anchorPos, anchorWallTime)
  // on every status update and then estimate the current position on each
  // animation frame, giving a smooth 60fps fill.
  const anchorRef = useRef<{ pos: number; t: number }>({ pos: 0, t: 0 });

  const bars = useMemo(() => generateBars(hashString(uri), BAR_COUNT), [uri]);

  useEffect(() => {
    let sound: Audio.Sound | null = null;

    Audio.Sound.createAsync(
      { uri },
      { shouldPlay: false, progressUpdateIntervalMillis: 50 },
      (status) => {
        if (!status.isLoaded) return;
        setDurationMs(status.durationMillis ?? 0);
        anchorRef.current = { pos: status.positionMillis ?? 0, t: Date.now() };
        setIsPlaying(status.isPlaying);
        if (status.didJustFinish) {
          setIsPlaying(false);
          anchorRef.current = { pos: 0, t: Date.now() };
          setPositionMs(0);
        } else {
          // Always trust the engine-reported position. While the rAF is
          // running it'll smooth this further; during the startup warmup
          // (rAF gated for 200ms) this keeps the waveform fill moving.
          setPositionMs(status.positionMillis ?? 0);
        }
      },
    ).then(({ sound: s }) => {
      sound = s;
      soundRef.current = s;
      setIsLoading(false);
    }).catch(() => {
      setIsLoading(false);
    });

    return () => {
      sound?.unloadAsync().catch(() => {});
    };
  }, [uri]);

  // Smooth interpolation between status ticks via rAF.
  //
  // Delicate part: at the very moment playback starts, the audio engine has a
  // small startup delay before it actually advances. expo-av flips
  // `isPlaying=true` BEFORE samples start coming out, so a wall-clock
  // extrapolation from the first anchor will get ahead of where the audio
  // really is — then the next status tick pulls the position back, producing
  // the visible "bounce". To avoid that we:
  //   1) Wait 200ms after isPlaying flips on before starting rAF.
  //   2) Clamp our estimate so it never runs more than the most recently
  //      reported positionMillis + (now - anchor time). The clamp prevents the
  //      estimate from drifting ahead of reality if the audio clock is slower
  //      than wall clock.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const start = setTimeout(() => {
      const tick = () => {
        const { pos, t } = anchorRef.current;
        const estimated = pos + (Date.now() - t) * speed;
        setPositionMs((prev) => (Math.abs(prev - estimated) > 8 ? estimated : prev));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, 200);
    return () => {
      clearTimeout(start);
      cancelAnimationFrame(raf);
    };
  }, [isPlaying, speed]);

  // Stable pause callback identity registered in the single-player registry.
  const pauseSelfRef = useRef<(() => void) | undefined>(undefined);
  if (!pauseSelfRef.current) {
    pauseSelfRef.current = () => {
      soundRef.current?.pauseAsync().catch(() => {});
    };
  }

  useEffect(() => {
    const fn = pauseSelfRef.current!;
    return () => clearActivePlayer(fn);
  }, []);

  const handleToggle = async () => {
    const sound = soundRef.current;
    if (!sound) return;
    try {
      if (isPlaying) {
        await sound.pauseAsync();
      } else {
        // Pause any other player that's currently sounding, then register self.
        setActivePlayer(pauseSelfRef.current!);
        if (positionMs >= durationMs && durationMs > 0) {
          await sound.setPositionAsync(0);
        }
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false });
        await sound.playAsync();
      }
    } catch {}
  };

  const handleSeek = async (e: GestureResponderEvent) => {
    const sound = soundRef.current;
    if (!sound || !durationMs) return;
    const layout = waveformLayout.current;
    if (!layout || layout.width <= 0) return;
    const localX = e.nativeEvent.locationX;
    const ratio = Math.max(0, Math.min(1, localX / layout.width));
    const target = Math.round(ratio * durationMs);
    try {
      await sound.setPositionAsync(target);
      anchorRef.current = { pos: target, t: Date.now() };
      setPositionMs(target);
    } catch {}
  };

  const cycleSpeed = async () => {
    const order = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const next = order[(order.indexOf(speed) + 1) % order.length];
    setSpeed(next);
    const sound = soundRef.current;
    if (sound) {
      try {
        await sound.setRateAsync(next, true);
      } catch {}
    }
  };

  const progress = durationMs > 0 ? positionMs / durationMs : 0;
  const displayMs = isPlaying || positionMs > 0 ? positionMs : durationMs;

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.bgPrimary }]}>
      <TouchableOpacity
        onPress={handleToggle}
        style={styles.playBtn}
        disabled={isLoading}
        activeOpacity={0.7}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={colors.textPrimary} />
        ) : isPlaying ? (
          <Pause size={20} color={colors.textPrimary} fill={colors.textPrimary} />
        ) : (
          <Play size={20} color={colors.textPrimary} fill={colors.textPrimary} />
        )}
      </TouchableOpacity>

      <View style={styles.middle}>
        <Pressable
          ref={waveformRef}
          style={styles.waveform}
          onPress={handleSeek}
          onLayout={(e) => {
            waveformLayout.current = { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width };
          }}
        >
          {bars.map((h, i) => {
            const filled = (i + 0.5) / BAR_COUNT <= progress;
            return (
              <View
                key={i}
                style={{
                  width: 2.5,
                  height: Math.max(3, h * 22),
                  borderRadius: 1.5,
                  backgroundColor: filled ? colors.brand : colors.bgTertiary,
                }}
              />
            );
          })}
        </Pressable>
      </View>

      <Text style={[styles.time, { color: colors.textMuted }]}>
        {durationMs > 0 ? formatDuration(displayMs) : '--:--'}
      </Text>

      <TouchableOpacity
        onPress={cycleSpeed}
        style={[styles.speedBtn, { backgroundColor: colors.bgSecondary }]}
        activeOpacity={0.7}
      >
        <Text style={[styles.speedText, { color: colors.textSecondary }]}>{speed}x</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    minWidth: 250,
    maxWidth: 300,
  },
  playBtn: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  middle: { flex: 1, overflow: 'hidden' },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
    gap: 2,
    overflow: 'hidden',
  },
  time: {
    fontSize: 12,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  speedBtn: {
    height: 36,
    width: 46,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedText: {
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
