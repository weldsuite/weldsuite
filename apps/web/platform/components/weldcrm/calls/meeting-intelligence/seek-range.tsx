import { cn } from '@/lib/utils';

interface SeekRangeProps {
  /** Current playback position in seconds. */
  value: number;
  /** Media duration in seconds; the control is disabled until it is known. */
  duration: number;
  /** Accessible name, e.g. "Seek". */
  label: string;
  /** Called with the requested playback position in seconds. */
  onSeek: (time: number) => void;
  className?: string;
}

/**
 * Invisible native `<input type="range">` laid over a custom-drawn seek bar
 * (the parent must be `relative`). The drawn track stays purely visual while
 * pointer drags, arrow keys and screen readers all go through the real slider.
 * The thumb is zero-width so the input value maps 1:1 onto the drawn track.
 */
export function SeekRange({ value, duration, label, onSeek, className }: Readonly<SeekRangeProps>) {
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return (
    <input
      type="range"
      min={0}
      max={max}
      step={1}
      value={Math.min(Math.max(value, 0), max)}
      disabled={max === 0}
      aria-label={label}
      onChange={(e) => onSeek(Number(e.target.value))}
      className={cn(
        'absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-default',
        '[&::-webkit-slider-thumb]:h-0 [&::-webkit-slider-thumb]:w-0 [&::-webkit-slider-thumb]:appearance-none',
        '[&::-moz-range-thumb]:h-0 [&::-moz-range-thumb]:w-0 [&::-moz-range-thumb]:border-0',
        className,
      )}
    />
  );
}
