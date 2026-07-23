
/**
 * Remote Cursors Component
 *
 * Renders cursor positions of other users in the whiteboard
 * with smooth animation and user name labels (Figma-style).
 */

import { memo, useMemo } from 'react';
import type { WhiteboardPresence } from '@/lib/realtime/whiteboard/types';
import { useTranslations } from '@weldsuite/i18n/client';

interface RemoteCursorData extends WhiteboardPresence {
  cursor: { x: number; y: number };
  sessionId?: string;
}

interface RemoteCursorsProps {
  cursors: RemoteCursorData[];
  viewTransform: {
    x: number;
    y: number;
    scale: number;
  };
  canvasBounds?: { width: number; height: number };
}

interface RemoteCursorProps {
  presence: RemoteCursorData;
  viewTransform: {
    x: number;
    y: number;
    scale: number;
  };
  uniqueKey: string;
}

const CursorIcon = memo(function CursorIcon({ color }: { color: string }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}
    >
      <path
        d="M5.65376 12.4563L5.65376 12.4563L5.01376 3.33631C4.9875 2.94959 5.4375 2.68906 5.7501 2.90631L5.7501 2.90631L20.7501 13.4063C21.0876 13.6407 20.9626 14.1563 20.5501 14.2438L20.5501 14.2438L12.8376 15.9313C12.7187 15.9563 12.6138 16.0235 12.5438 16.1188L12.5438 16.1188L8.23126 21.7063C7.96876 22.0438 7.43751 21.9688 7.28751 21.5688L7.28751 21.5688L5.65376 12.4563Z"
        fill={color}
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
});

const RemoteCursor = memo(function RemoteCursor({
  presence,
  viewTransform,
}: Omit<RemoteCursorProps, 'uniqueKey'>) {
  const st = useTranslations();
  // Transform canvas coordinates to screen coordinates
  const screenX = presence.cursor.x * viewTransform.scale + viewTransform.x;
  const screenY = presence.cursor.y * viewTransform.scale + viewTransform.y;

  const firstName = presence.name?.split(' ')[0] || st('sweep.weldflow.remoteCursors.defaultUserName');

  return (
    <div
      className="pointer-events-none absolute z-[9999]"
      style={{
        left: screenX,
        top: screenY,
        transform: 'translate(-2px, -2px)',
        transition: 'left 50ms linear, top 50ms linear',
      }}
    >
      <CursorIcon color={presence.color} />
      <div
        className="absolute left-5 top-4 flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium text-white shadow-md"
        style={{
          backgroundColor: presence.color,
        }}
      >
        {presence.avatar && (
          <img
            src={presence.avatar}
            alt={presence.name}
            className="h-4 w-4 rounded-full"
          />
        )}
        <span>{firstName}</span>
        {presence.tool && (
          <span className="ml-1 opacity-70">• {presence.tool}</span>
        )}
      </div>
    </div>
  );
});

export const RemoteCursors = memo(function RemoteCursors({
  cursors,
  viewTransform,
}: RemoteCursorsProps) {
  // Filter out cursors that are off-screen (optional optimization)
  const visibleCursors = useMemo(() => {
    return cursors.filter((cursor) => {
      const screenX = cursor.cursor.x * viewTransform.scale + viewTransform.x;
      const screenY = cursor.cursor.y * viewTransform.scale + viewTransform.y;
      // Keep cursors within a reasonable margin of the viewport
      return screenX > -200 && screenX < 4000 && screenY > -200 && screenY < 4000;
    });
  }, [cursors, viewTransform]);

  if (visibleCursors.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {visibleCursors.map((presence, index) => (
        <RemoteCursor
          key={presence.sessionId || `${presence.id}-${index}`}
          presence={presence}
          viewTransform={viewTransform}
        />
      ))}
    </div>
  );
});
