
import * as React from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PricingDialog } from '@/components/pricing-dialog';
import { Pause } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';

export const segments = [
  {
    speaker: 'Sales Rep',
    type: 'sales' as const,
    time: '0:00',
    words: 'Hi, thanks for taking my call today. I wanted to walk you through how our platform can help streamline...'.split(' '),
  },
  {
    speaker: 'Customer',
    type: 'customer' as const,
    time: '1:12',
    words: "Sure, we've been looking for a solution that integrates with our existing CRM workflow...".split(' '),
  },
  {
    speaker: 'Sales Rep',
    type: 'sales' as const,
    time: '2:45',
    words: "Absolutely, that's exactly what we built this for. Let me show you the integration...".split(' '),
  },
  {
    speaker: 'Customer',
    type: 'customer' as const,
    time: '3:18',
    words: 'That looks great. What about pricing for teams?'.split(' '),
  },
  {
    speaker: 'Sales Rep',
    type: 'sales' as const,
    time: '4:02',
    words: "We have flexible plans starting at ten seats. I can send you a detailed breakdown after this call.".split(' '),
  },
  {
    speaker: 'Customer',
    type: 'customer' as const,
    time: '4:45',
    words: "That would be helpful. We also need SSO and audit logs for compliance requirements.".split(' '),
  },
  {
    speaker: 'Sales Rep',
    type: 'sales' as const,
    time: '5:30',
    words: "Both are included in our enterprise tier. Let me walk.".split(' '),
  },
  {
    speaker: 'Customer',
    type: 'customer' as const,
    time: '6:15',
    words: "Perfect, that checks all the boxes. Can we schedule a follow-up with our IT team next week?".split(' '),
  },
  {
    speaker: 'Sales Rep',
    type: 'sales' as const,
    time: '7:00',
    words: "Of course. I'll send over a calendar invite today along with the proposal and technical docs.".split(' '),
  },
  {
    speaker: 'Customer',
    type: 'customer' as const,
    time: '7:48',
    words: "Sounds good. One more thing, do you offer a trial period before we commit to an annual plan?".split(' '),
  },
  {
    speaker: 'Sales Rep',
    type: 'sales' as const,
    time: '8:30',
    words: "Yes, we offer a fourteen-day free trial with full access to all features including the enterprise ones.".split(' '),
  },
  {
    speaker: 'Customer',
    type: 'customer' as const,
    time: '9:12',
    words: "Excellent. Let's get the trial set up then and go from there. Thanks for the thorough walkthrough.".split(' '),
  },
];

// Pre-compute total words and segment start indices
export const segmentStartIndices = segments.reduce<number[]>((acc, seg, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + segments[i - 1].words.length);
  return acc;
}, []);
export const totalWords = segmentStartIndices[segments.length - 1] + segments[segments.length - 1].words.length;

export const START_INDEX = Math.floor(totalWords / 2);
export const START_SECONDS = Math.floor(0.35 * 754);

// Common filler/short words spoken very quickly
const fastWords = new Set(['I', 'a', 'an', 'the', 'to', 'in', 'is', 'it', 'of', 'we', 'do', 'or', 'on', 'at', 'be', 'so', 'up', 'if', 'my', 'no', 'us']);

export function getWordDelay(wordIdx: number) {
  if (wordIdx >= totalWords) return 800;

  let word = '';
  let wordPosInSegment = 0;
  let segmentLength = 0;
  let isFirstWord = false;

  for (let s = 0; s < segments.length; s++) {
    const start = segmentStartIndices[s];
    if (wordIdx >= start && wordIdx < start + segments[s].words.length) {
      word = segments[s].words[wordIdx - start];
      wordPosInSegment = wordIdx - start;
      segmentLength = segments[s].words.length;
      isFirstWord = wordIdx === start;
      break;
    }
  }

  if (isFirstWord) return 700 + Math.random() * 500;

  const cleanWord = word.replace(/[.,!?;:'"]/g, '');
  const len = cleanWord.length;

  if (fastWords.has(cleanWord)) return 100 + Math.random() * 80;

  let base: number;
  if (len <= 2) base = 130;
  else if (len <= 4) base = 200;
  else if (len <= 6) base = 280;
  else if (len <= 8) base = 340;
  else if (len <= 10) base = 400;
  else base = 460;

  const posRatio = wordPosInSegment / segmentLength;
  if (posRatio < 0.15) base *= 1.2;
  else if (posRatio > 0.85) base *= 1.15;

  const jitter = ((Math.random() + Math.random()) / 2 - 0.5) * 160;

  let punctuationPause = 0;
  if (word.endsWith('...')) punctuationPause = 400 + Math.random() * 200;
  else if (word.endsWith('.') || word.endsWith('?') || word.endsWith('!')) punctuationPause = 300 + Math.random() * 150;
  else if (word.endsWith(',') || word.endsWith(';')) punctuationPause = 150 + Math.random() * 100;

  const thinkPause = Math.random() < 0.1 ? 200 + Math.random() * 200 : 0;

  return Math.max(80, base + jitter + punctuationPause + thinkPause);
}

export function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const COPIES = 15;
const TOTAL_RENDERED = segments.length * COPIES;

// Unified Segment component — custom memo prevents inactive segments from
// re-rendering on every word-index tick (only active segment re-renders).
const Segment = React.memo(
  function Segment({
    seg,
    segIdx,
    isActive,
    wrappedWordIndex,
    displayTime,
  }: {
    seg: (typeof segments)[0];
    segIdx: number;
    isActive: boolean;
    wrappedWordIndex: number;
    displayTime: string;
  }) {
    const isSales = seg.type === 'sales';
    const segStart = segmentStartIndices[segIdx];

    return (
      <div className="flex items-start gap-2.5 flex-shrink-0">
        <div
          className={`w-[18px] h-[18px] rounded-[6px] flex items-center justify-center flex-shrink-0 mt-0.5 ${isSales ? 'bg-blue-100' : 'bg-emerald-100'}`}
        >
          <span className={`text-[9px] font-semibold ${isSales ? 'text-blue-600' : 'text-emerald-600'}`}>
            {isSales ? 'S' : 'C'}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-[11px] font-medium ${isSales ? 'text-blue-600' : 'text-emerald-600'}`}>
              {seg.speaker}
            </span>
            <span className="text-[9px] text-gray-300">{displayTime}</span>
          </div>
          {isActive ? (
            <p className="text-[11px] text-gray-600 leading-relaxed">
              {seg.words.map((word, wordIdx) => {
                const absIdx = segStart + wordIdx;
                const isHighlighted = absIdx === wrappedWordIndex;
                return (
                  <span
                    key={wordIdx}
                    className="transition-colors duration-300 ease-in-out rounded-[3px] px-[1px] -mx-[1px]"
                    style={{
                      backgroundColor: isHighlighted ? 'rgb(254 240 138)' : 'transparent',
                    }}
                  >
                    {word}
                    {wordIdx < seg.words.length - 1 ? ' ' : ''}
                  </span>
                );
              })}
            </p>
          ) : (
            <p className="text-[11px] text-gray-600 leading-relaxed">{seg.words.join(' ')}</p>
          )}
        </div>
      </div>
    );
  },
  (prev, next) => {
    // Always re-render when active status flips
    if (prev.isActive !== next.isActive) return false;
    // Inactive: skip unless segment data or display time changed
    if (!next.isActive) {
      return prev.seg === next.seg && prev.displayTime === next.displayTime;
    }
    // Active: re-render on word or time changes
    return (
      prev.wrappedWordIndex === next.wrappedWordIndex &&
      prev.displayTime === next.displayTime &&
      prev.seg === next.seg
    );
  },
);

// Renders all segment copies in a tall container and uses the browser's native
// smooth-scroll to keep the active segment at ~35% from the top.  No translateY
// state, no key-based remounting — the DOM never swaps content so no bounce.
export function TranscriptContent({
  activeSegIdx,
  wrappedWordIndex,
  elapsedSeconds,
}: {
  activeSegIdx: number;
  wrappedWordIndex: number;
  elapsedSeconds: number;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = React.useState(0);
  const prevActiveRef = React.useRef(activeSegIdx);
  const isInitialized = React.useRef(false);
  const animFrameRef = React.useRef(0);

  // During the render where the wrap fires we already need the bumped
  // generation so absoluteActiveIdx points at the NEXT copy, not back to
  // copy-0.  The state update happens in the effect below.
  let effectiveGeneration = generation;
  if (prevActiveRef.current > 8 && activeSegIdx < 3 && prevActiveRef.current !== activeSegIdx) {
    effectiveGeneration = generation + 1;
  }

  const absoluteActiveIdx = effectiveGeneration * segments.length + activeSegIdx;

  // Persist generation into state + update the ref for the next comparison.
  React.useEffect(() => {
    if (prevActiveRef.current > 8 && activeSegIdx < 3) {
      setGeneration((g) => g + 1);
    }
    prevActiveRef.current = activeSegIdx;
  }, [activeSegIdx]);

  // Custom eased scroll — longer duration + ease-out for a softer feel.
  const smoothScrollTo = React.useCallback((container: HTMLElement, target: number, duration = 300) => {
    cancelAnimationFrame(animFrameRef.current);
    const start = container.scrollTop;
    const distance = target - start;
    if (Math.abs(distance) < 1) return;
    const startTime = performance.now();

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      container.scrollTop = start + distance * easeOutCubic(progress);
      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      }
    };
    animFrameRef.current = requestAnimationFrame(step);
  }, []);

  // Instant scroll on first mount (useLayoutEffect runs before paint).
  React.useLayoutEffect(() => {
    if (isInitialized.current) return;
    const container = scrollRef.current;
    const inner = container?.firstElementChild;
    if (!container || !inner || !inner.children[absoluteActiveIdx]) return;
    const el = inner.children[absoluteActiveIdx] as HTMLElement;
    container.scrollTop = el.offsetTop - container.clientHeight * 0.65;
    isInitialized.current = true;
  }, [absoluteActiveIdx]);

  // Smooth scroll on every subsequent segment change.
  React.useEffect(() => {
    if (!isInitialized.current) return;
    const container = scrollRef.current;
    const inner = container?.firstElementChild;
    if (!container || !inner || !inner.children[absoluteActiveIdx]) return;
    const el = inner.children[absoluteActiveIdx] as HTMLElement;
    smoothScrollTo(container, el.offsetTop - container.clientHeight * 0.65);
  }, [absoluteActiveIdx, smoothScrollTo]);

  // Cleanup animation frame on unmount
  React.useEffect(() => {
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  return (
    <div ref={scrollRef} className="flex-1 relative bg-white px-4 py-3 overflow-hidden">
      <div className="flex flex-col gap-3">
        {Array.from({ length: TOTAL_RENDERED }, (_, i) => {
          const segIdx = i % segments.length;
          const seg = segments[segIdx];
          const isActive = i === absoluteActiveIdx;
          const isNear = Math.abs(i - absoluteActiveIdx) <= 5;
          const displayTime = isNear
            ? formatTime(Math.max(0, elapsedSeconds + (i - absoluteActiveIdx) * 45))
            : seg.time;

          return (
            <Segment
              key={i}
              seg={seg}
              segIdx={segIdx}
              isActive={isActive}
              wrappedWordIndex={wrappedWordIndex}
              displayTime={displayTime}
            />
          );
        })}
      </div>
    </div>
  );
}

export function CallIntelligenceIllustration() {
  const [globalWordIndex, setGlobalWordIndex] = React.useState(START_INDEX);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(START_SECONDS);
  const [mounted, setMounted] = React.useState(false);
  const wordIndexRef = React.useRef(START_INDEX);
  const tMeet = getTranslations('weldmeet');

  React.useEffect(() => {
    const t = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(t);
  }, []);

  // Words advance at realistic variable speed
  React.useEffect(() => {
    if (!mounted) return;
    let cancelled = false;

    const advance = () => {
      if (cancelled) return;
      wordIndexRef.current += 1;
      setGlobalWordIndex(wordIndexRef.current);
      const wrappedIdx = wordIndexRef.current % totalWords;
      setTimeout(advance, getWordDelay(wrappedIdx));
    };

    const timeout = setTimeout(advance, getWordDelay(wordIndexRef.current));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [mounted]);

  // Player time ticks every 1 second
  React.useEffect(() => {
    if (!mounted) return;
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [mounted]);

  const wrappedWordIndex = globalWordIndex % totalWords;

  let activeSegIdx = segments.findIndex((_seg, i) => {
    const start = segmentStartIndices[i];
    return wrappedWordIndex >= start && wrappedWordIndex < start + segments[i].words.length;
  });
  if (activeSegIdx === -1) activeSegIdx = 0;

  const progress = ((elapsedSeconds % 754) / 754) * 100;
  const elapsed = formatTime(elapsedSeconds);

  return (
    <div className="flex-1 hidden lg:flex items-center overflow-hidden h-[427px] py-6 pl-6">
      <div className="flex flex-col h-full w-[calc(100%+40px)] overflow-hidden rounded-l-xl border border-r-0 border-gray-200 bg-white">
        {/* Mini header bar */}
        <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-200 bg-white">
          <div className="text-[12px] font-medium text-gray-800">Outbound Call to +1 (555) 012-3456</div>
        </div>

        {/* Audio player area */}
        <div className="px-4 py-3 bg-white border-b border-gray-200">
          <div className="flex items-center gap-2.5">
            <div className="w-5 h-5 rounded-full bg-gray-900 flex items-center justify-center flex-shrink-0">
              <Pause className="w-2 h-2 text-white fill-white" />
            </div>
            <span className="text-[10px] font-mono text-gray-500">{elapsed}</span>
            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gray-900 rounded-full transition-all duration-200 ease-linear"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-gray-400">12:34</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-3 px-4 pt-[3px] pb-0 bg-white border-b border-gray-200">
          <div className="relative pb-2">
            <span className="text-[11px] font-medium text-gray-900">{tMeet.weldcall.illustration.transcript}</span>
            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gray-900 rounded-full" />
          </div>
          <div className="pb-2">
            <span className="text-[11px] font-medium text-gray-400">{tMeet.weldcall.illustration.speakers}</span>
          </div>
          <div className="pb-2">
            <span className="text-[11px] font-medium text-gray-400">{tMeet.weldcall.illustration.details}</span>
          </div>
        </div>

        {/* Transcript content — endless scrolling */}
        <TranscriptContent
          activeSegIdx={activeSegIdx}
          wrappedWordIndex={wrappedWordIndex}
          elapsedSeconds={elapsedSeconds}
        />
      </div>
    </div>
  );
}

export function CallIntelligenceUpgradePrompt() {
  const [showPricingDialog, setShowPricingDialog] = React.useState(false);
  const t = getTranslations('weldmeet');

  return (
    <div className="px-4 md:px-6 pb-8 max-w-4xl mx-auto space-y-8 min-h-[calc(100vh-64px)] flex flex-col justify-center">
      <Card className="overflow-hidden py-0 rounded-xl">
        <CardContent className="p-0">
          <div className="flex flex-col lg:flex-row min-h-[427px]">
            {/* Left side - Text content */}
            <div className="flex-1 flex flex-col pl-6 py-6">
              {/* Title and description at top */}
              <div>
                <h2 className="font-[550] tracking-tight">
                  <span className="text-[22px]">{t.weldcall.upgradePrompt.title}</span>
                  <br />
                  <span className="text-xl text-muted-foreground">
                    {t.weldcall.upgradePrompt.subtitle}
                    <br />
                    {t.weldcall.upgradePrompt.description}
                  </span>
                </h2>
              </div>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Buttons at bottom */}
              <div className="flex items-center gap-3">
                <Button
                  onClick={() => setShowPricingDialog(true)}
                  className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
                >
                  {t.weldcall.upgradePrompt.upgrade}
                </Button>
                <Button variant="outline" className="rounded-lg">
                  {t.weldcall.upgradePrompt.learnMore}
                </Button>
              </div>
            </div>

            {/* Right side - Illustration */}
            <CallIntelligenceIllustration />
          </div>
        </CardContent>
      </Card>

      <PricingDialog
        open={showPricingDialog}
        onOpenChange={setShowPricingDialog}
        excludePlans={['business']}
        highlightPlan="scale"
        hideHeaderBar
        featureHighlight={{
          feature: 'Call Intelligence',
          description: 'Upgrade to access Call Intelligence',
          plan: 'Pro',
        }}
      />
    </div>
  );
}
