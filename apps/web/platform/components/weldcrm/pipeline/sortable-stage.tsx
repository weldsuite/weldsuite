
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { ReactNode, createContext, useContext } from 'react';
import { useDroppableContext } from './droppable-stage';

interface SortableStageContextType {
  attributes: any;
  listeners: any;
  isDragging: boolean;
}

const SortableStageContext = createContext<SortableStageContextType | null>(null);

export const useSortableStage = () => {
  const context = useContext(SortableStageContext);
  return context;
};

interface SortableStageProps {
  id: string;
  children: ReactNode;
  isDragging?: boolean;
}

export function SortableStage({ id, children, isDragging }: SortableStageProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSorting,
  } = useSortable({ 
    id: `sortable-stage-${id}`,
    data: {
      type: 'stage',
      stageId: id
    }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isSorting ? undefined : transition,
  };

  const droppableContext = useDroppableContext();
  const isOver = droppableContext?.isOver || false;

  return (
    <SortableStageContext.Provider value={{ attributes, listeners, isDragging: isSorting }}>
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          "flex-shrink-0 w-[240px] relative overflow-visible",
          (isDragging || isSorting) && "opacity-50 z-50"
        )}
        data-stage-sortable={id}
      >
        {children}
      </div>
    </SortableStageContext.Provider>
  );
}