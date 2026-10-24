'use client';

import { useCallback, useEffect, useRef } from 'react';
import { PAD_HEIGHT, PAD_WIDTH, inkColor } from '@/lib/signature';

interface SignaturePadProps {
  label: string;
  /** Called with the canvas whenever the drawing changes; null when cleared. */
  onChange: (canvas: HTMLCanvasElement | null) => void;
  /** Bump to clear the pad from outside. */
  clearToken: number;
}

/** Pointer/touch drawing surface. Strokes are smoothed with quadratic curves between midpoints. */
export function SignaturePad({ label, onChange, clearToken }: Readonly<SignaturePadProps>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const hasInk = useRef(false);

  const reset = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    last.current = null;
    drawing.current = false;
  }, []);

  useEffect(() => {
    reset();
    onChange(null);
    // Only a new clearToken should wipe the pad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearToken]);

  function point(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function style(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = inkColor();
    ctx.fillStyle = inkColor();
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const ctx = e.currentTarget.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    last.current = p;
    style(ctx);
    // A tap leaves a dot.
    ctx.beginPath();
    ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    hasInk.current = true;
  }

  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    style(ctx);
    // Coalesced events give a smoother line on fast strokes.
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const samples = events.length > 0 ? events : [e.nativeEvent];
    for (const ev of samples) {
      const p = {
        x: ((ev.clientX - rect.left) / rect.width) * canvas.width,
        y: ((ev.clientY - rect.top) / rect.height) * canvas.height,
      };
      const prev = last.current;
      const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last.current = p;
    }
  }

  function onUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (hasInk.current) onChange(e.currentTarget);
  }

  return (
    <canvas
      ref={canvasRef}
      width={PAD_WIDTH}
      height={PAD_HEIGHT}
      role="img"
      aria-label={label}
      className="block aspect-[3/1] w-full touch-none cursor-crosshair rounded-md border border-dashed border-input bg-white"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}
