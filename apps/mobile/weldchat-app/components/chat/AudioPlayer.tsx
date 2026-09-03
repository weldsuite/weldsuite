import { useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  type GestureResponderEvent,
} from 'react-native';
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  setAudioModeAsync,
} from 'expo-audio';
import { Play, Pause } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { BRAND } from '@/lib/brand';

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
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const v = ((s >>> 0) % 1000) / 1000;
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

// Module-level registry: only one AudioPlayer may play at a time.
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
  const [speed, setSpeed] = useState(1);
  const [smoothPositionMs, setSmoothPositionMs] = useState(0);
  const waveformRef = useRef<View | null>(null);
  const waveformLayout = useRef<{ x: number; width: number } | null>(null);
  const anchorRef = useRef<{ pos: number; t: number }>({ pos: 0, t: 0 });

  const player = useAudioPlayer(uri, { updateInterval: 50 });
  const status = useAudioPlayerStatus(player);

  const isPlaying = status.playing;
  const isLoading = !status.isLoaded;
  const durationMs = Math.round((status.duration || 0) * 1000);
  const reportedPositionMs = Math.round((status.currentTime || 0) * 1000);

  const bars = useMemo(() => generateBars(hashString(uri), BAR_COUNT), [uri]);

  useEffect(() => {
    anchorRef.current = { pos: reportedPositionMs, t: Date.now() };
    if (status.didJustFinish) {
      setSmoothPositionMs(0);
      anchorRef.current = { pos: 0, t: Date.now() };
    } else {
      setSmoothPositionMs(reportedPositionMs);
    }
  }, [reportedPositionMs, status.didJustFinish]);

  // Smooth interpolation between status ticks via rAF.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const start = setTimeout(() => {
      const tick = () => {
        const { pos, t } = anchorRef.current;
        const estimated = pos + (Date.now() - t) * speed;
        setSmoothPositionMs((prev) => (Math.abs(prev - estimated) > 8 ? estimated : prev));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, 200);
    return () => {
      clearTimeout(start);
      cancelAnimationFrame(raf);
    };
  }, [isPlaying, speed]);

  const pauseSelfRef = useRef<() => void>(() => {});
  pauseSelfRef.current = () => {
    try {
      player.pause();
    } catch {
      // ignore
    }
  };

  // Stable identity for the single-player registry.
  const registryPauseRef = useRef(() => {
    pauseSelfRef.current();
  });

  useEffect(() => {
    const fn = registryPauseRef.current;
    return () => clearActivePlayer(fn);
  }, []);

  const handleToggle = async () => {
    try {
      if (isPlaying) {
        player.pause();
      } else {
        setActivePlayer(registryPauseRef.current);
        if (smoothPositionMs >= durationMs && durationMs > 0) {
          await player.seekTo(0);
        }
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
        player.play();
      }
    } catch {
      // ignore
    }
  };

  const handleSeek = async (e: GestureResponderEvent) => {
    if (!durationMs) return;
    const layout = waveformLayout.current;
    if (!layout || layout.width <= 0) return;
    const localX = e.nativeEvent.locationX;
    const ratio = Math.max(0, Math.min(1, localX / layout.width));
    const targetMs = Math.round(ratio * durationMs);
    try {
      await player.seekTo(targetMs / 1000);
      anchorRef.current = { pos: targetMs, t: Date.now() };
      setSmoothPositionMs(targetMs);
    } catch {
      // ignore
    }
  };

  const cycleSpeed = () => {
    const order = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const next = order[(order.indexOf(speed) + 1) % order.length];
    setSpeed(next);
    try {
      player.setPlaybackRate(next);
    } catch {
      // ignore
    }
  };

  const progress = durationMs > 0 ? smoothPositionMs / durationMs : 0;
  const displayMs = isPlaying || smoothPositionMs > 0 ? smoothPositionMs : durationMs;

  return (
    <View style={[styles.container, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <TouchableOpacity
        onPress={handleToggle}
        style={styles.playBtn}
        disabled={isLoading}
        activeOpacity={0.7}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={colors.text} />
        ) : isPlaying ? (
          <Pause size={20} color={colors.text} fill={colors.text} />
        ) : (
          <Play size={20} color={colors.text} fill={colors.text} />
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
                  backgroundColor: filled ? BRAND : colors.secondary,
                }}
              />
            );
          })}
        </Pressable>
      </View>

      <Text style={[styles.time, { color: colors.muted }]}>
        {durationMs > 0 ? formatDuration(displayMs) : '--:--'}
      </Text>

      <TouchableOpacity
        onPress={cycleSpeed}
        style={[styles.speedBtn, { backgroundColor: colors.cardBackground }]}
        activeOpacity={0.7}
      >
        <Text style={[styles.speedText, { color: colors.mutedForeground }]}>{speed}x</Text>
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
