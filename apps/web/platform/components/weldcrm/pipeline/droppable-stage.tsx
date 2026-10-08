
import React, { createContext, useContext, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';

interface DroppableStageProps {
  id: string;
  children: React.ReactNode;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

const DroppableContext = createContext<{ isOver: boolean }>({ isOver: false });

export const useDroppableContext = () => useContext(DroppableContext);

export function DroppableStage({ id, children, containerRef }: Readonly<DroppableStageProps>) {
  const { isOver, setNodeRef } = useDroppable({
    id: `stage-${id}`,
  });
  const stageRef = React.useRef<HTMLDivElement>(null);
  const [overlayStyle, setOverlayStyle] = React.useState<React.CSSProperties>({});

  React.useEffect(() => {
    if (isOver && stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      const containerBottom = containerRef?.current
        ? containerRef.current.getBoundingClientRect().bottom
        : undefined;
      setOverlayStyle({
        position: 'fixed',
        top: rect.top - 16,
        left: rect.left - 8,
        width: rect.width + 16,
        bottom: containerBottom !== undefined ? window.innerHeight - containerBottom : 0,
        borderRadius: 0,
      });
    }
  }, [isOver, containerRef]);

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
            className="!bg-blue-100 dark:!bg-blue-300 pointer-events-none z-10"
            style={overlayStyle}
          />
        )}
        <div className="relative z-20">{children}</div>
      </div>
    </DroppableContext.Provider>
  );
}
