'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';

import type { TimeSlot } from '../actions';

interface TimeSlotListProps {
  selectedDate: Date | null;
  initialLoading: boolean;
  slotsLoading: boolean;
  slots: TimeSlot[];
  use24h: boolean;
  timezone: string;
  onUse24hChange: (use24h: boolean) => void;
  onSlotSelect: (slot: TimeSlot) => void;
}

export function TimeSlotList({
  selectedDate,
  initialLoading,
  slotsLoading,
  slots,
  use24h,
  timezone,
  onUse24hChange,
  onSlotSelect,
}: TimeSlotListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) {
      setOverflows(false);
      return;
    }
    const check = () => {
      setOverflows((prev) => {
        const next = el.scrollHeight > el.clientHeight;
        return prev === next ? prev : next;
      });
    };
    check();
    const raf1 = requestAnimationFrame(check);
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(check));
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true, attributes: true });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      ro.disconnect();
      mo.disconnect();
    };
  });

  const formatTime = (date: Date) =>
    formatInTimeZone(date, timezone, use24h ? 'HH:mm' : 'h:mm a');

  const availableSlots = slots.filter((s) => s.available);

  return (
    <div className="w-full md:w-[280px] shrink-0 pl-6 md:pl-5 pt-6 md:pt-[14px] pb-6 md:pb-5 overflow-hidden flex flex-col min-h-0">
      {selectedDate ? (
        <>
          <div
            className={`flex items-center justify-between pr-6 md:pr-5 -ml-6 md:-ml-5 pl-6 md:pl-5 border-b transition-colors ${
              scrolled ? 'border-gray-200 dark:border-[#26262B]' : 'border-transparent'
            }`}
            style={{ paddingBottom: 14 }}
          >
            <h3 className="text-base md:text-sm font-medium text-gray-900 dark:text-[#F2F2F4] tabular-nums">
              {format(selectedDate, 'EEEE, MMMM d')}
            </h3>
            <Tabs
              value={use24h ? '24h' : '12h'}
              onValueChange={(v) => onUse24hChange(v === '24h')}
            >
              <TabsList className="h-8 md:h-[30px] rounded-md">
                <TabsTrigger
                  value="12h"
                  className="text-[13px] md:text-xs px-2.5 md:px-2 py-0.5 rounded-[5px] tabular-nums"
                >
                  12h
                </TabsTrigger>
                <TabsTrigger
                  value="24h"
                  className="text-[13px] md:text-xs px-2.5 md:px-2 py-0.5 rounded-[5px] tabular-nums"
                >
                  24h
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {slotsLoading ? (
            <div className="flex items-center justify-center flex-1 text-sm text-gray-400 dark:text-[#6E6E76]">
              <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading slots" />
            </div>
          ) : availableSlots.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-[#6E6E76] text-center mt-8 pr-5">
              No available times
            </p>
          ) : (
            <div
              ref={containerRef}
              className="space-y-2 overflow-y-auto flex-1 scrollbar-thin pr-6 md:pr-5"
              style={overflows ? { paddingRight: 8 } : undefined}
              onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
            >
              {availableSlots.map((slot) => (
                <button
                  type="button"
                  key={slot.start}
                  onClick={() => onSlotSelect(slot)}
                  className="w-full px-3 py-2.5 md:py-2 text-sm font-medium tabular-nums text-gray-700 dark:text-[#E4E4E7] bg-gray-200/30 dark:bg-[#1F1F23]/40 border border-gray-200 dark:border-[#2E2E33] rounded-lg hover:bg-gray-200/60 dark:hover:bg-[#2E2E33]/60 transition-colors text-center"
                >
                  {formatTime(new Date(slot.start))}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center flex-1 text-sm text-gray-400 dark:text-[#6E6E76] pr-5">
          {initialLoading ? (
            <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
          ) : (
            <p className="text-center">Select a date</p>
          )}
        </div>
      )}
    </div>
  );
}
