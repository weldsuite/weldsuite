
import React, { createContext, useContext, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';

interface DroppableStageProps {
  id: string;
  children: React.ReactNode;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * An element the drop highlight must stop above (the board's calculation
   * bar), instead of running to the bottom of the container.
   */
  bottomBoundaryRef?: React.RefObject<HTMLElement | null>;
}

/** Highlight of the stage a card is dragged over — the neutral hover tint used by list rows. */
export const DROP_TARGET_HIGHLIGHT = 'bg-gray-100 dark:bg-secondary/50';

/** Viewport `bottom` offset for a drop highlight: above the boundary when given, else at the container's bottom. */
export function dropHighlightBottom(
  containerRef?: React.RefObject<HTMLElement | null>,
  bottomBoundaryRef?: React.RefObject<HTMLElement | null>,
): number {
  const boundary = bottomBoundaryRef?.current;
  if (boundary) return window.innerHeight - boundary.getBoundingClientRect().top;
  const container = containerRef?.current;
  return container ? window.innerHeight - container.getBoundingClientRect().bottom : 0;
}

const DroppableContext = createContext<{ isOver: boolean }>({ isOver: false });

export const useDroppableContext = () => useContext(DroppableContext);

export function DroppableStage({ id, children, containerRef, bottomBoundaryRef }: Readonly<DroppableStageProps>) {
  const { isOver, setNodeRef } = useDroppable({
    id: `stage-${id}`,
  });
  const stageRef = React.useRef<HTMLDivElement>(null);
  const [overlayStyle, setOverlayStyle] = React.useState<React.CSSProperties>({});

  React.useEffect(() => {
    if (isOver && stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      setOverlayStyle({
        position: 'fixed',
        top: rect.top - 16,
        left: rect.left - 8,
        width: rect.width + 16,
        bottom: dropHighlightBottom(containerRef, bottomBoundaryRef),
        borderRadius: 0,
      });
    }
  }, [isOver, containerRef, bottomBoundaryRef]);

  const contextValue = useMemo(() => ({ isOver }), [isOver]);

  return (
    <DroppableContext.Provider value={contextValue}>
      <div
        ref={(node) => {
          setNodeRef(node);
          (stageRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        className={cn(
          "group flex flex-col w-full h-full rounded-t-lg rounded-b-md relative transition-colors duration-200",
          isOver && "!rounded-none"
        )}
      >
        {isOver && (
          <div
            className={cn(DROP_TARGET_HIGHLIGHT, 'pointer-events-none z-10')}
            style={overlayStyle}
          />
        )}
        <div className="relative z-20">{children}</div>
      </div>
    </DroppableContext.Provider>
  );
}
