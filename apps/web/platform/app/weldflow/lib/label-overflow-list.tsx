import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { resolveLabelColor } from './label-color';

export interface OverflowLabel {
  id: string;
  name: string;
  color?: string | null;
}

interface LabelOverflowListProps {
  labels: OverflowLabel[];
  className?: string;
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function LabelOverflowList({ labels, className }: LabelOverflowListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(labels.length);

  useIsoLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const recalc = () => {
      const width = container.clientWidth;
      if (width === 0) return;
      const items = Array.from(measure.querySelectorAll('[data-measure-item]')) as HTMLElement[];
      const overflow = measure.querySelector('[data-measure-overflow]') as HTMLElement | null;
      const overflowWidth = overflow?.getBoundingClientRect().width ?? 0;
      const gap = 4;
      let used = 0;
      let count = 0;
      for (let i = 0; i < items.length; i++) {
        const w = items[i].getBoundingClientRect().width;
        const next = used + (i > 0 ? gap : 0) + w;
        const remaining = items.length - i - 1;
        const reserve = remaining > 0 ? gap + overflowWidth : 0;
        if (next + reserve > width) break;
        used = next;
        count++;
      }
      setVisibleCount(count);
    };

    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(container);
    return () => ro.disconnect();
  }, [labels]);

  if (labels.length === 0) return null;

  const visible = labels.slice(0, visibleCount);
  const overflow = labels.length - visibleCount;

  return (
    <div ref={containerRef} className={cn('relative flex items-center gap-1 flex-1 min-w-0 overflow-hidden', className)}>
      <div
        ref={measureRef}
        className="absolute -top-[9999px] left-0 flex items-center gap-1 pointer-events-none"
        aria-hidden="true"
      >
        {labels.map((label) => (
          <Badge
            key={`m-${label.id}`}
            data-measure-item
            className="px-1.5 py-px rounded text-[11px] font-medium border-transparent text-white"
            style={{ backgroundColor: resolveLabelColor(label.color) }}
          >
            {label.name}
          </Badge>
        ))}
        <span data-measure-overflow className="ml-0.5 text-[12px] font-mono text-gray-500">
          +{labels.length}
        </span>
      </div>
      {visible.map((label) => (
        <Badge
          key={label.id}
          className="px-1.5 py-px rounded text-[11px] font-medium border-transparent text-white"
          style={{ backgroundColor: resolveLabelColor(label.color) }}
        >
          {label.name}
        </Badge>
      ))}
      {overflow > 0 && (
        <span className="ml-0.5 text-[12px] font-mono text-gray-500 flex-shrink-0">+{overflow}</span>
      )}
    </div>
  );
}
