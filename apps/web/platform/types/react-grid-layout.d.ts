declare module 'react-grid-layout' {
  import type { ComponentType, ReactNode } from 'react';

  export interface Layout {
    i: string;
    x: number;
    y: number;
    w: number;
    h: number;
    minW?: number;
    minH?: number;
    maxW?: number;
    maxH?: number;
    static?: boolean;
    isDraggable?: boolean;
    isResizable?: boolean;
  }

  export type ResizeHandleAxis = 's' | 'w' | 'e' | 'n' | 'sw' | 'nw' | 'se' | 'ne';

  export interface GridLayoutProps {
    className?: string;
    layout?: Layout[];
    cols?: number;
    rowHeight?: number;
    width?: number;
    onLayoutChange?: (layout: Layout[]) => void;
    draggableHandle?: string;
    onDragStart?: (layout: Layout[], oldItem: Layout, newItem: Layout, placeholder: Layout, event: MouseEvent, element: HTMLElement) => void;
    onDragStop?: (layout: Layout[], oldItem: Layout, newItem: Layout, placeholder: Layout, event: MouseEvent, element: HTMLElement) => void;
    isDraggable?: boolean;
    isResizable?: boolean;
    resizeHandles?: ResizeHandleAxis[];
    margin?: [number, number];
    containerPadding?: [number, number];
    children?: ReactNode;
  }

  const GridLayout: ComponentType<GridLayoutProps>;
  export default GridLayout;
}
