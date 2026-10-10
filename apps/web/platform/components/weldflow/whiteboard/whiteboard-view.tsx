
import { useState, useRef, useEffect, useCallback } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { Button } from '@weldsuite/ui/components/button';
import { ProjectToolbar } from '@/components/weldflow/project-toolbar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Slider } from '@weldsuite/ui/components/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import {
  MousePointer2,
  Square,
  Circle,
  Type,
  StickyNote,
  Pen,
  Eraser,
  Hand,
  ArrowUpRight,
  ChevronDown,
  Presentation,
  Undo2,
  Redo2,
  Minus,
  Plus,
  ArrowRight,
  CornerDownRight,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  Copy,
  Link,
  BringToFront,
  SendToBack,
  ArrowUp,
  ArrowDown,
  Clipboard,
  ClipboardPaste,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { useUser } from '@clerk/clerk-react';
import { useWhiteboardCollaboration } from '@/hooks/use-whiteboard-collaboration';
import { RemoteCursors } from './remote-cursors';
import { PresenceIndicator } from './presence-indicator';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  applyDragDelta,
  computeConnectionHover,
  computeCornerRadius,
  computeEllipseBounds,
  computeRectangleBounds,
  computeResizeUpdate,
  consolidateErasedPaths,
  createElementFromTouch,
  createOffsetCopy,
  findArrowHandle,
  findConnectionTarget,
  findErasedElementIds,
  findResizeHandle,
  getArrowCurvePoints,
  getArrowHandleUpdate,
  getElementConnectionPoints,
  getEllipseRadii,
  getFillModeUpdates,
  getToolbarSync,
  hitTestElement,
  interpolateEraserPoints,
  isElementInSelectionBox,
  isFillableShape,
  patchElement,
  snapshotDragStart,
  touchDistance,
  touchMidpoint,
  translateFromStart,
  trimEraserPath,
} from './whiteboard-geometry';
import type {
  ArrowHandle,
  ArrowType,
  ConnectionPointName,
  ConnectionPoints,
  CornerHandle,
  CornerRadiusDragStart,
  DragStart,
  Point,
  ResizeHandle,
  TouchPoint,
  WhiteboardElement,
} from './whiteboard-geometry';
import {
  ConnectionHandles,
  ConnectionHoverPoints,
  CornerRadiusHandles,
  EraserPreview,
  ResizeHandles,
  ToolButton,
  areBoundsEqual,
  focusTextareaAtEnd,
  getCanvasCursor,
  getCanvasSvgStyle,
  getTextAnchor,
  positionTextConnectionPoints,
  setPaddedBounds,
} from './whiteboard-parts';

// Fixed zoom stops. Module scope so the array identity is stable across renders.
const zoomLevels = [0.025, 0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5]; // Same as commerce builder

// Touch hit-test slack for arrows and freehand paths, in canvas units: a bit
// larger than a mouse pointer needs.
const TOUCH_LINE_TOLERANCE = 15;

/** Index of the zoom stop closest to `scale`. */
function nearestZoomIndex(scale: number): number {
  return zoomLevels.reduce(
    (prev, curr, index) => (Math.abs(curr - scale) < Math.abs(zoomLevels[prev] - scale) ? index : prev),
    0
  );
}

type Tool = 'select' | 'pan' | 'rectangle' | 'circle' | 'text' | 'sticky' | 'pen' | 'eraser' | 'arrow';

// Tools whose options show the stroke-width, fill-mode and font-size controls.
const STROKE_WIDTH_TOOLS: ReadonlySet<Tool> = new Set(['pen', 'rectangle', 'circle', 'arrow']);
const FILL_MODE_TOOLS: ReadonlySet<Tool> = new Set(['rectangle', 'circle']);
const FONT_SIZE_TOOLS: ReadonlySet<Tool> = new Set(['text', 'sticky']);

interface WhiteboardViewProps {
  projectId: string;
  whiteboardId?: string;
  initialElements?: WhiteboardElement[];
}

/** The lines of a text element, each with the offset it starts at in the text. */
function textLines(text: string): { offset: number; line: string }[] {
  let offset = 0;
  return text.split('\n').map((line) => {
    const entry = { offset, line };
    offset += line.length + 1;
    return entry;
  });
}

export function WhiteboardView({ projectId, whiteboardId, initialElements = [] }: Readonly<WhiteboardViewProps>) {
  const st = useTranslations();
  const { canWrite } = useProjectPermissions();
  const { user } = useUser();
  const { getClient } = useAppApiClient();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Swap black/dark colors to light equivalents in dark mode for visibility
  const displayColor = useCallback((color: string | undefined, fallback = '#000000') => {
    const c = color || fallback;
    if (!isDark) return c;
    if (c === '#000000' || c === '#000' || c === 'black') return '#ffffff';
    if (c === '#374151') return '#d1d5db';
    return c;
  }, [isDark]);

  // Real-time collaboration
  const {
  isConnected,
  remoteCursors,
  remotePresence,
  broadcastElementAdd,
  broadcastElementUpdate,
  broadcastElementDelete,
  broadcastCursor,
  broadcastSelectionChange,
  onElementAdd,
  onElementUpdate,
  onElementDelete,
} = useWhiteboardCollaboration({
    projectId,
    whiteboardId,
    userId: user?.id || '',
    userName: user?.fullName || user?.firstName || 'Anonymous',
    userAvatar: user?.imageUrl,
    enabled: !!user?.id,
  });

  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>(canWrite ? 'select' : 'pan');
  // Permissions can resolve after mount: once write access arrives, leave the
  // read-only 'pan' default, but never override a tool the user picked since.
  const prevCanWriteRef = useRef(canWrite);
  useEffect(() => {
    if (canWrite && !prevCanWriteRef.current) {
      setTool(prev => (prev === 'pan' ? 'select' : prev));
    }
    prevCanWriteRef.current = canWrite;
  }, [canWrite]);
  const [elements, setElements] = useState<WhiteboardElement[]>(initialElements);

  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [selectedElements, setSelectedElements] = useState<Set<string>>(new Set());
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [isZooming, setIsZooming] = useState(false);
  const zoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomRef = useRef(1); // Ref mirror of zoom state for high-frequency handlers
  const zoomRafRef = useRef<number | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  const [panPosition, setPanPosition] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1); // Start at 100% zoom (1.0 scale)
  const [zoomIndex, setZoomIndex] = useState(8); // Index 8 = 100% in zoomLevels array
  const [startPoint, setStartPoint] = useState({ x: 0, y: 0 });
  const [currentPath, setCurrentPath] = useState<{ x: number; y: number }[]>([]);
  const [selectedColor, setSelectedColor] = useState('#FFE500');
  const [hoveredColor, setHoveredColor] = useState<string | null>(null);
  const [strokeColor, setStrokeColor] = useState('#000000');
  const [isPresentMode, setIsPresentMode] = useState(false);
  const [isErasing, setIsErasing] = useState(false);
  const [eraserSize, setEraserSize] = useState(20);
  const [eraserPath, setEraserPath] = useState<{ x: number; y: number }[]>([]);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [fontSize, setFontSize] = useState(16);
  const [fillMode, setFillMode] = useState<'fill' | 'stroke' | 'both'>('both');
  const [arrowType, setArrowType] = useState<ArrowType>('arrow');
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<'nw' | 'ne' | 'sw' | 'se' | null>(null);
  const [resizeStartSize, setResizeStartSize] = useState({ width: 0, height: 0, x: 0, y: 0 });
  const [editingElement, setEditingElement] = useState<string | null>(null);
  const [isMiddleMouseDown, setIsMiddleMouseDown] = useState(false);
  const [isDraggingElement, setIsDraggingElement] = useState(false);
  const [textBoundingBox, setTextBoundingBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const textBoundingBoxesRef = useRef<Map<string, { x: number; y: number; width: number; height: number }>>(new Map());
  const [textBboxVersion, setTextBboxVersion] = useState(0); // Trigger arrow updates when text bboxes change
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });
  const [dragElementStart, setDragElementStart] = useState<{
    x: number;
    y: number;
    endX?: number;
    endY?: number;
    points?: { x: number; y: number }[];
  }>({ x: 0, y: 0 });
  const [dragElementsStart, setDragElementsStart] = useState<Map<string, { x: number; y: number; endX?: number; endY?: number; points?: { x: number; y: number }[] }>>(new Map());
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkInputValue, setLinkInputValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; elementId: string } | null>(null);
  const [clipboard, setClipboard] = useState<WhiteboardElement[]>([]);

  // Connection drawing state
  const [isDrawingConnection, setIsDrawingConnection] = useState(false);
  const [connectionStart, setConnectionStart] = useState<{
    elementId: string;
    point: 'top' | 'right' | 'bottom' | 'left';
    x: number;
    y: number;
  } | null>(null);
  const [connectionEndPoint, setConnectionEndPoint] = useState<{ x: number; y: number } | null>(null);
  const [hoveredConnectionElement, setHoveredConnectionElement] = useState<string | null>(null);
  const [snappedConnectionPoint, setSnappedConnectionPoint] = useState<'top' | 'right' | 'bottom' | 'left' | null>(null);

  // Arrow editing state
  const [isDraggingArrowHandle, setIsDraggingArrowHandle] = useState<'start' | 'end' | 'curve' | null>(null);
  const [arrowDragStart, setArrowDragStart] = useState<{ x: number; y: number } | null>(null);

  // Corner radius editing state for rectangles
  const [isDraggingCornerRadius, setIsDraggingCornerRadius] = useState<'tl' | 'tr' | 'bl' | 'br' | null>(null);
  const [cornerRadiusDragStart, setCornerRadiusDragStart] = useState<{ x: number; y: number; initialRadius: number } | null>(null);

  // Global mouseup listener to ensure arrow dragging and corner radius dragging are always cleared
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDraggingArrowHandle) {
        setIsDraggingArrowHandle(null);
        setArrowDragStart(null);
      }
      if (isDraggingCornerRadius) {
        setIsDraggingCornerRadius(null);
        setCornerRadiusDragStart(null);
      }
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [isDraggingArrowHandle, isDraggingCornerRadius]);

  // Clear text bounding box when selection changes
  useEffect(() => {
    setTextBoundingBox(null);
  }, [selectedElement]);

  // Update selected element when properties change
  const updateSelectedElement = useCallback((updates: Partial<WhiteboardElement>) => {
    if (selectedElement) {
      setElements(prev => prev.map(el =>
        el.id === selectedElement ? { ...el, ...updates } : el
      ));
      // Broadcast style changes
      void broadcastElementUpdate(selectedElement, updates);
    }
  }, [selectedElement, broadcastElementUpdate]);
  
  // Update stroke width for selected element. Deliberately keyed on
  // strokeWidth/tool only — this effect calls updateSelectedElement, which
  // calls setElements; including `elements` would re-trigger itself on its
  // own write and loop. `selectedElement` isn't included either since this
  // must fire on a toolbar change, not on selection change (that's the
  // "Sync properties" effect below, which runs the opposite direction).
  useEffect(() => {
    if (selectedElement && tool !== 'eraser') {
      const element = elements.find(el => el.id === selectedElement);
      if (element && (element.type === 'rectangle' || element.type === 'circle' ||
          element.type === 'arrow' || element.type === 'path')) {
        updateSelectedElement({ strokeWidth });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokeWidth, tool]);

  // Update font size for selected element. Same reasoning as above — must
  // stay keyed on fontSize only to avoid looping through its own setElements.
  useEffect(() => {
    if (selectedElement) {
      const element = elements.find(el => el.id === selectedElement);
      if (element && (element.type === 'text' || element.type === 'sticky')) {
        updateSelectedElement({ fontSize });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize]);

  // Update fill mode for selected element. Same reasoning as above — must
  // stay keyed on fillMode only to avoid looping through its own setElements.
  useEffect(() => {
    if (selectedElement) {
      const element = elements.find(el => el.id === selectedElement);
      if (element && isFillableShape(element)) {
        updateSelectedElement(getFillModeUpdates(element, fillMode, selectedColor, strokeColor));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillMode]);

  // Sync properties when selecting an element. Deliberately excludes
  // `elements` — this must fire only on selection change, not on every
  // element mutation (e.g. dragging), or it would keep resyncing the
  // toolbar mid-interaction.
  useEffect(() => {
    if (!selectedElement || tool === 'eraser') return;
    const element = elements.find(el => el.id === selectedElement);
    if (!element) return;
    const sync = getToolbarSync(element);
    if (sync.strokeWidth !== undefined) setStrokeWidth(sync.strokeWidth);
    if (sync.fontSize !== undefined) setFontSize(sync.fontSize);
    if (sync.fillMode) setFillMode(sync.fillMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedElement, tool]);

  // Canvas bounds constants
  const CANVAS_WIDTH = 16000;
  const CANVAS_HEIGHT = 9000;
  const CANVAS_MARGIN = 500; // Gray border area
  const TOTAL_CANVAS_WIDTH = CANVAS_WIDTH + CANVAS_MARGIN * 2;
  const TOTAL_CANVAS_HEIGHT = CANVAS_HEIGHT + CANVAS_MARGIN * 2;

  // Clamp pan position to canvas bounds
  // Canvas SVG is centered at origin: extends from (-8500,-5000) to (8500,5000) including margin
  // panPosition maps SVG origin (0,0) to screen position, so canvas edges in screen space are:
  //   left: panPosition.x - halfW, right: panPosition.x + halfW (where halfW = TOTAL_CANVAS_WIDTH/2 * zoom)
  const clampPanPosition = useCallback((x: number, y: number, currentZoom: number) => {
    const { width: viewportWidth, height: viewportHeight } = viewportSizeRef.current;
    const halfW = (TOTAL_CANVAS_WIDTH / 2) * currentZoom;
    const halfH = (TOTAL_CANVAS_HEIGHT / 2) * currentZoom;

    // Keep at least 30% of viewport overlapping with canvas
    const overlapX = viewportWidth * 0.3;
    const overlapY = viewportHeight * 0.3;

    // Canvas right edge (x + halfW) must be at least overlapX into viewport
    const minX = overlapX - halfW;
    // Canvas left edge (x - halfW) must not go past viewportWidth - overlapX
    const maxX = viewportWidth - overlapX + halfW;

    const minY = overlapY - halfH;
    const maxY = viewportHeight - overlapY + halfH;

    return {
      x: Math.min(maxX, Math.max(minX, x)),
      y: Math.min(maxY, Math.max(minY, y)),
    };
  }, [TOTAL_CANVAS_WIDTH, TOTAL_CANVAS_HEIGHT]);

  // Handle document-level mouse events during resize/drag/connection to prevent losing track when hovering over toolbar
  useEffect(() => {
    if (!isResizing && !isDraggingElement && !isPanning && !isDrawing && !isDrawingConnection && !isDraggingArrowHandle) return;

    // Resize the selected element towards the pointer. Returns false when it no longer exists.
    const resizeSelectedElement = (point: Point, shiftKey: boolean): boolean => {
      const element = elements.find(el => el.id === selectedElement);
      if (!element || !resizeHandle) return false;
      const update = computeResizeUpdate(element, resizeHandle, resizeStartSize, point, shiftKey, true);
      if (update) {
        setElements(prev => patchElement(prev, selectedElement, update));
      }
      return true;
    };

    // While drawing a connection: snap the end to the nearest connection point,
    // otherwise follow the mouse position
    const updateConnectionHover = (point: Point, sourceElementId: string) => {
      const { elementUnderCursor, nearest } = computeConnectionHover(elements, sourceElementId, point);
      if (nearest) {
        setConnectionEndPoint(nearest.point);
        setHoveredConnectionElement(nearest.elementId);
        setSnappedConnectionPoint(nearest.name);
      } else {
        setConnectionEndPoint(point);
        setHoveredConnectionElement(elementUnderCursor);
        setSnappedConnectionPoint(null);
      }
    };

    // Move the dragged handle (start, end or curve control) of the selected arrow
    const dragArrowHandle = (point: Point, handle: ArrowHandle) => {
      const arrowElement = elements.find(el => el.id === selectedElement);
      if (arrowElement?.type !== 'arrow') return;
      const update = getArrowHandleUpdate(handle, point);
      setElements(prev => patchElement(prev, selectedElement, update));
    };

    const handleDocumentMouseMove = (e: MouseEvent) => {
      // Calculate canvas coordinates
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = (e.clientX - rect.left - panPosition.x) / zoom;
      const y = (e.clientY - rect.top - panPosition.y) / zoom;
      const point = { x, y };

      if (isPanning) {
        const newX = e.clientX - panStart.x;
        const newY = e.clientY - panStart.y;
        setPanPosition(clampPanPosition(newX, newY, zoom));
        return;
      }

      if (isDraggingElement && selectedElement) {
        const deltaX = point.x - dragStartPos.x;
        const deltaY = point.y - dragStartPos.y;
        const drag = { dragElementsStart, dragElementStart, selectedElement };
        setElements(prev => applyDragDelta(prev, drag, deltaX, deltaY));
        return;
      }

      if (isResizing && resizeHandle && selectedElement && !resizeSelectedElement(point, e.shiftKey)) {
        return;
      }

      // Handle connection drawing
      if (isDrawingConnection && connectionStart) {
        updateConnectionHover(point, connectionStart.elementId);
      }

      // Handle arrow handle dragging
      if (isDraggingArrowHandle && selectedElement && arrowDragStart) {
        dragArrowHandle(point, isDraggingArrowHandle);
      }
    };

    const handleDocumentMouseUp = () => {
      if (isResizing) {
        setIsResizing(false);
        setResizeHandle(null);
        // History will be added by the existing handleMouseUp or via effect
        needsHistoryRef.current = true;
      }
      if (isDraggingElement) {
        setIsDraggingElement(false);
        setDragElementsStart(new Map());
        needsHistoryRef.current = true;
      }
      if (isPanning && isMiddleMouseDown) {
        setIsMiddleMouseDown(false);
        setIsPanning(false);
      }
      if (isDraggingArrowHandle) {
        setIsDraggingArrowHandle(null);
        setArrowDragStart(null);
        needsHistoryRef.current = true;
      }
      // Connection drawing mouse up is handled in the SVG
    };

    document.addEventListener('mousemove', handleDocumentMouseMove);
    document.addEventListener('mouseup', handleDocumentMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleDocumentMouseMove);
      document.removeEventListener('mouseup', handleDocumentMouseUp);
    };
  }, [isResizing, isDraggingElement, isPanning, isDrawing, isDrawingConnection, isDraggingArrowHandle, isMiddleMouseDown, selectedElement, resizeHandle, resizeStartSize, dragStartPos, dragElementStart, dragElementsStart, panStart, panPosition, zoom, elements, connectionStart, arrowDragStart, clampPanPosition]);

  const lastProcessedPoint = useRef<{ x: number; y: number } | null>(null);
  const eraserUpdateQueue = useRef<Array<{ point: { x: number; y: number }, size: number }>>([]);
  const eraserBatchTimer = useRef<NodeJS.Timeout | null>(null);
  const needsHistoryRef = useRef(false);

  // History management for undo/redo
  const [history, setHistory] = useState<WhiteboardElement[][]>([initialElements]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const maxHistorySize = 50;

  // Auto-save whiteboard data to database
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedElementsRef = useRef<string>(JSON.stringify(initialElements));

  // Save function that can be called directly
  const saveWhiteboard = useCallback(async (elementsToSave: WhiteboardElement[]) => {
    // Read-only viewers never write (the API would 403). Remote edits still land
    // in `elements`; once write access resolves the autosave effect re-runs.
    if (!canWrite) return;
    const elementsJson = JSON.stringify(elementsToSave);
    // Skip if nothing changed
    if (elementsJson === lastSavedElementsRef.current) {
      return;
    }

    try {
      const client = await getClient();
      // `PUT /projects/:projectId/whiteboard[/:id]` never existed (api-worker mounts
      // no projects routes). Canonical surface: `PATCH /api/whiteboards/:id` to update
      // an existing board, `POST /api/whiteboards` (with projectId) to create one.
      // The client throws on a non-2xx, so reaching the next line means it saved.
      if (whiteboardId) {
        await client.patch<{ data: unknown }>(`/whiteboards/${whiteboardId}`, {
          elements: elementsToSave,
        });
      } else {
        await client.post<{ data: unknown }>('/whiteboards', {
          projectId,
          elements: elementsToSave,
        });
      }
      lastSavedElementsRef.current = elementsJson;
    } catch (error) {
      console.error('Failed to save whiteboard:', error);
      toast.error(st('sweep.weldflow.whiteboardView.saveFailed'));
    } finally {
    }
  }, [canWrite, projectId, whiteboardId, getClient, st]);

  useEffect(() => {
    // Skip initial render (when initialElements are being loaded)
    if (elements === initialElements) {
      return;
    }

    // Quick debounce (500ms) to batch rapid changes
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      void saveWhiteboard(elements);
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [elements, initialElements, saveWhiteboard]);

  // Subscribe to remote element changes (real-time collaboration)
  useEffect(() => {
    if (!isConnected) return;

    const unsubAdd = onElementAdd((element: unknown, _userId: string) => {
      setElements(prev => [...prev, element as WhiteboardElement]);
    });

    const unsubUpdate = onElementUpdate((elementId: string, changes: Partial<WhiteboardElement>, _userId: string) => {
      setElements(prev => prev.map(el =>
        el.id === elementId ? { ...el, ...changes } : el
      ));
    });

    const unsubDelete = onElementDelete((elementId: string, _userId: string) => {
      setElements(prev => prev.filter(el => el.id !== elementId));
    });

    return () => {
      unsubAdd();
      unsubUpdate();
      unsubDelete();
    };
  }, [isConnected, onElementAdd, onElementUpdate, onElementDelete]);

  // Broadcast selection changes to other users
  useEffect(() => {
    if (!isConnected) return;
    const selectedIds = selectedElement
      ? [selectedElement]
      : Array.from(selectedElements);
    void broadcastSelectionChange(selectedIds);
  }, [selectedElement, selectedElements, isConnected, broadcastSelectionChange]);

  // Add to history
  const addToHistory = useCallback(() => {
    setHistory(prev => {
      // Remove any history after current index (when we do something after undo)
      const newHistory = prev.slice(0, historyIndex + 1);
      
      // Add current state
      newHistory.push([...elements]);
      
      // Limit history size
      if (newHistory.length > maxHistorySize) {
        newHistory.shift();
        return newHistory;
      }
      
      return newHistory;
    });
    setHistoryIndex(prev => Math.min(prev + 1, maxHistorySize - 1));
  }, [elements, historyIndex]);

  // Handle history after document-level mouse up (for resize/drag over toolbar)
  useEffect(() => {
    if (needsHistoryRef.current && !isResizing && !isDraggingElement) {
      needsHistoryRef.current = false;
      setTimeout(addToHistory, 100);
    }
  }, [isResizing, isDraggingElement, addToHistory]);

  // Undo function
  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setElements(history[newIndex]);
      setHistoryIndex(newIndex);
    }
  }, [history, historyIndex]);

  // Redo function
  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setElements(history[newIndex]);
      setHistoryIndex(newIndex);
    }
  }, [history, historyIndex]);

  // Helper functions for collaborative element operations
  const addElementWithBroadcast = useCallback((element: WhiteboardElement) => {
    setElements(prev => [...prev, element]);
    // Always try to broadcast - the broadcast function checks connection internally
    void broadcastElementAdd(element);
  }, [broadcastElementAdd]);

  const _updateElementWithBroadcast = useCallback((elementId: string, changes: Partial<WhiteboardElement>) => {
    setElements(prev => prev.map(el =>
      el.id === elementId ? { ...el, ...changes } : el
    ));
    void broadcastElementUpdate(elementId, changes);
  }, [broadcastElementUpdate]);

  const deleteElementWithBroadcast = useCallback((elementId: string) => {
    setElements(prev => prev.filter(el => el.id !== elementId));
    void broadcastElementDelete(elementId);
  }, [broadcastElementDelete]);

  // Get connection points for an element (top, right, bottom, left)
  const getConnectionPoints = useCallback((element: WhiteboardElement): ConnectionPoints | null => {
    // Text uses its measured bounding box when available for accurate positioning
    return getElementConnectionPoints(element, textBoundingBoxesRef.current.get(element.id));
  }, []);

  // Get connection point position for a connected arrow
  const getConnectionPointPosition = useCallback((elementId: string, point: 'top' | 'right' | 'bottom' | 'left'): { x: number; y: number } | null => {
    const element = elements.find(el => el.id === elementId);
    if (!element) return null;
    const points = getConnectionPoints(element);
    if (!points) return null;
    return points[point];
  }, [elements, getConnectionPoints]);

  // Update connected arrows when their connected elements move
  useEffect(() => {
    // Find all arrows that have connections
    const connectedArrows = elements.filter(el =>
      el.type === 'arrow' && (el.startElementId || el.endElementId)
    );

    if (connectedArrows.length === 0) return;

    let needsUpdate = false;
    const updatedElements = elements.map(el => {
      if (el.type !== 'arrow') return el;

      const updates: Partial<WhiteboardElement> = {};

      // Update start position if connected to an element
      if (el.startElementId && el.startConnectionPoint) {
        const startPos = getConnectionPointPosition(el.startElementId, el.startConnectionPoint);
        if (startPos && (el.x !== startPos.x || el.y !== startPos.y)) {
          updates.x = startPos.x;
          updates.y = startPos.y;
          needsUpdate = true;
        }
      }

      // Update end position if connected to an element
      if (el.endElementId && el.endConnectionPoint) {
        const endPos = getConnectionPointPosition(el.endElementId, el.endConnectionPoint);
        if (endPos && (el.endX !== endPos.x || el.endY !== endPos.y)) {
          updates.endX = endPos.x;
          updates.endY = endPos.y;
          needsUpdate = true;
        }
      }

      if (Object.keys(updates).length > 0) {
        return { ...el, ...updates };
      }
      return el;
    });

    if (needsUpdate) {
      setElements(updatedElements);
    }
  }, [elements, getConnectionPointPosition, textBboxVersion]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip shortcuts when editing text
      if (editingElement) return;

      // Delete selected element
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElement) {
        deleteElementWithBroadcast(selectedElement);
        setSelectedElement(null);
        addToHistory();
      }

      // Undo: Ctrl/Cmd + Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }

      // Redo: Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }

    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedElement, undo, redo, addToHistory, editingElement, deleteElementWithBroadcast]);

  // Colors for sticky notes and shapes
  const colors = [
    '#000000', // Black
    '#FFE500', // Yellow
    '#FF9F1A', // Orange
    '#FF5582', // Pink
    '#B692F6', // Purple
    '#5AC8FA', // Blue
    '#64D2A1', // Green
  ];
  
  const [currentPoint, setCurrentPoint] = useState({ x: 0, y: 0, shiftKey: false });
  
   // Single constant for ring thickness
   // Limit interpolation for performance
   // Minimum movement before processing
  
  // Calculate viewBox for minimap based on all elements - memoized for performance
  const getMinimapViewBox = useCallback(() => {
    if (elements.length === 0) {
      return '-500 -500 2000 1500';
    }
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    elements.forEach(el => {
      // Update bounds based on element type
      if (el.x !== undefined) {
        minX = Math.min(minX, el.x);
        minY = Math.min(minY, el.y);
        maxX = Math.max(maxX, el.x + (el.width || 0));
        maxY = Math.max(maxY, el.y + (el.height || 0));
      }
      
      if (el.type === 'circle') {
        const rx = el.radiusX ?? el.radius ?? 50;
        const ry = el.radiusY ?? el.radius ?? 50;
        minX = Math.min(minX, el.x - rx);
        minY = Math.min(minY, el.y - ry);
        maxX = Math.max(maxX, el.x + rx);
        maxY = Math.max(maxY, el.y + ry);
      }
      
      if (el.type === 'arrow' && el.endX && el.endY) {
        minX = Math.min(minX, el.x, el.endX);
        minY = Math.min(minY, el.y, el.endY);
        maxX = Math.max(maxX, el.x, el.endX);
        maxY = Math.max(maxY, el.y, el.endY);
      }
      
      if (el.type === 'path' && el.points) {
        el.points.forEach(p => {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        });
      }
    });
    
    // Add padding
    const padding = 200;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;
    
    // Calculate dimensions
    const width = maxX - minX;
    const height = maxY - minY;
    
    // Maintain aspect ratio for minimap (3:2)
    const aspectRatio = 192 / 128; // 1.5
    const currentRatio = width / height;
    
    if (currentRatio > aspectRatio) {
      // Width is too wide, adjust height
      const newHeight = width / aspectRatio;
      const heightDiff = (newHeight - height) / 2;
      minY -= heightDiff;
      maxY += heightDiff;
    } else {
      // Height is too tall, adjust width
      const newWidth = height * aspectRatio;
      const widthDiff = (newWidth - width) / 2;
      minX -= widthDiff;
      maxX += widthDiff;
    }
    
    return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
  }, [elements]);

  // Render arrow/line based on type
  const renderArrowLine = (element: WhiteboardElement, isSelected: boolean = false) => {
    if (!element.endX || !element.endY) return null;

    const baseColor = displayColor(element.strokeColor);
    const color = isSelected ? '#3b82f6' : baseColor;
    const width = element.strokeWidth || 2;

    if (element.arrowType === 'elbow') {
      const midX = element.x + (element.endX - element.x) / 2;
      const pathData = `M ${element.x} ${element.y} L ${midX} ${element.y} L ${midX} ${element.endY} L ${element.endX} ${element.endY}`;

      return (
        <>
          <path
            d={pathData}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {renderArrowHead(midX, element.endY, element.endX, element.endY, color, width)}
        </>
      );
    } else {
      const hasArrow = element.arrowType === 'arrow';
      const curvePoints = getArrowCurvePoints(element);
      if (!curvePoints) return null;

      const { startX, startY, endX, endY, cp1x, cp1y, cp2x, cp2y } = curvePoints;
      const pathData = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
      const tangentX = endX - cp2x;
      const tangentY = endY - cp2y;

      return (
        <>
          <path
            d={pathData}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeLinecap="round"
          />
          {hasArrow && renderArrowHeadWithTangent(endX, endY, tangentX, tangentY, color, width)}
        </>
      );
    }
  };

  // Render arrow head using tangent direction (for curved arrows)
  const renderArrowHeadWithTangent = (x: number, y: number, tangentX: number, tangentY: number, color: string, strokeWidth: number) => {
    const angle = Math.atan2(tangentY, tangentX);
    const headLength = 10;
    const headAngle = Math.PI / 6;

    return (
      <path
        d={`M ${x - headLength * Math.cos(angle - headAngle)} ${y - headLength * Math.sin(angle - headAngle)} L ${x} ${y} L ${x - headLength * Math.cos(angle + headAngle)} ${y - headLength * Math.sin(angle + headAngle)}`}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  };

  // Render arrow head
  const renderArrowHead = (x1: number, y1: number, x2: number, y2: number, color: string, strokeWidth: number) => {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLength = 10;
    const headAngle = Math.PI / 6;
    
    return (
      <path
          d={`M ${x2 - headLength * Math.cos(angle - headAngle)} ${y2 - headLength * Math.sin(angle - headAngle)} L ${x2} ${y2} L ${x2 - headLength * Math.cos(angle + headAngle)} ${y2 - headLength * Math.sin(angle + headAngle)}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
    );
  };

  // Cache viewport dimensions to avoid layout thrashing
  const viewportSizeRef = useRef({ width: 800, height: 600 });

  const hasCenteredRef = useRef(false);

  useEffect(() => {
    const updateViewportSize = () => {
      if (canvasRef.current) {
        viewportSizeRef.current = {
          width: canvasRef.current.clientWidth,
          height: canvasRef.current.clientHeight
        };
      }
    };
    updateViewportSize();
    // Center the canvas on first mount
    if (!hasCenteredRef.current && canvasRef.current) {
      hasCenteredRef.current = true;
      const vw = viewportSizeRef.current.width;
      const vh = viewportSizeRef.current.height;
      setPanPosition({ x: vw / 2, y: vh / 2 });
    }
    window.addEventListener('resize', updateViewportSize);
    return () => window.removeEventListener('resize', updateViewportSize);
  }, []);

  // Cache canvas rect position to avoid layout thrashing
  const canvasRectRef = useRef({ left: 0, top: 0 });

  useEffect(() => {
    const updateCanvasRect = () => {
      if (canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        canvasRectRef.current = { left: rect.left, top: rect.top };
      }
    };
    updateCanvasRect();
    window.addEventListener('resize', updateCanvasRect);
    window.addEventListener('scroll', updateCanvasRect);
    return () => {
      window.removeEventListener('resize', updateCanvasRect);
      window.removeEventListener('scroll', updateCanvasRect);
    };
  }, []);

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    const { left, top } = canvasRectRef.current;
    return {
      x: (screenX - left - panPosition.x) / zoom,
      y: (screenY - top - panPosition.y) / zoom
    };
  }, [panPosition, zoom]);

  // Fullscreen functions
  const enterFullscreen = async () => {
    if (containerRef.current) {
      try {
        await containerRef.current.requestFullscreen();
      } catch (err) {
        console.error('Error entering fullscreen:', err);
      }
    }
  };

  const exitFullscreen = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (err) {
        console.error('Error exiting fullscreen:', err);
      }
    }
  };

  const togglePresentMode = async () => {
    if (!isPresentMode) {
      setIsPresentMode(true);
      await enterFullscreen();
    } else {
      setIsPresentMode(false);
      await exitFullscreen();
    }
  };

  // Listen for fullscreen changes to sync state
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && isPresentMode) {
        setIsPresentMode(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [isPresentMode]);

  // Batch process eraser updates for performance
  const processBatchedErasing = useCallback(() => {
    if (eraserUpdateQueue.current.length === 0) return;
    
    const updates = [...eraserUpdateQueue.current];
    eraserUpdateQueue.current = [];

    setElements(prevElements => {
      // Check which elements should be removed
      const elementsToRemove = findErasedElementIds(prevElements, updates);

      // Broadcast deletions to other clients
      elementsToRemove.forEach(id => broadcastElementDelete(id));

      // Return filtered elements without the ones that were touched
      return prevElements.filter(element => !elementsToRemove.has(element.id));
    });
  }, [broadcastElementDelete]);
  
  // Queue eraser updates for batching
  const queueEraserUpdate = useCallback((point: { x: number; y: number }, size: number) => {
    // For smooth erasing without flicker, process immediately
    eraserUpdateQueue.current = [{ point, size }];
    processBatchedErasing();
    eraserUpdateQueue.current = [];
  }, [processBatchedErasing]);
  
  // Erase at a point immediately, without any delay
  const eraseNow = (eraserPoint: { x: number; y: number }, currentEraserSize: number) => {
    if (eraserBatchTimer.current) {
      clearTimeout(eraserBatchTimer.current);
    }
    eraserUpdateQueue.current = [{ point: eraserPoint, size: currentEraserSize }];
    processBatchedErasing();
  };

  // Queue an erase through the batch, skipping points that barely moved
  const eraseBatched = (eraserPoint: { x: number; y: number }, currentEraserSize: number) => {
    // Skip if point hasn't moved enough
    if (lastProcessedPoint.current) {
      const dist = Math.sqrt(
        Math.pow(eraserPoint.x - lastProcessedPoint.current.x, 2) +
        Math.pow(eraserPoint.y - lastProcessedPoint.current.y, 2)
      );
      if (dist < 2) return; // Reduced threshold for smoother erasing
    }
    lastProcessedPoint.current = eraserPoint;
    queueEraserUpdate(eraserPoint, currentEraserSize);
  };

  // Start panning from the current pointer position
  const beginPan = (e: React.MouseEvent) => {
    setIsPanning(true);
    setPanStart({
      x: e.clientX - panPosition.x,
      y: e.clientY - panPosition.y
    });
  };

  // If the click landed on a resize or arrow handle of the selected element, start dragging it
  const tryStartHandleDrag = (e: React.MouseEvent, point: Point, element: WhiteboardElement): boolean => {
    // Check if clicking on a resize handle
    const resize = findResizeHandle(element, point, zoom);
    if (resize) {
      e.preventDefault(); // Prevent text selection
      setIsResizing(true);
      setResizeHandle(resize.handle);
      setResizeStartSize({
        width: resize.box.width,
        height: resize.box.height,
        x: resize.box.x,
        y: resize.box.y,
      });
      return true;
    }

    // Check if clicking on arrow handles
    if (element.type !== 'arrow') return false;
    const arrowHandle = findArrowHandle(element, point, zoom);
    if (!arrowHandle) return false;
    e.preventDefault();
    setIsDraggingArrowHandle(arrowHandle.handle);
    setArrowDragStart(arrowHandle.position);
    return true;
  };

  // Start dragging every element of the current multi-selection
  const beginMultiElementDrag = (point: Point) => {
    if (!canWrite) return;
    setIsDraggingElement(true);
    setDragStartPos(point);

    // Store starting positions for all selected elements
    const startPositions = new Map<string, DragStart>();
    elements.forEach(el => {
      if (selectedElements.has(el.id)) {
        startPositions.set(el.id, snapshotDragStart(el));
      }
    });
    setDragElementsStart(startPositions);
  };

  // Select a single element and start dragging it
  const beginSingleElementDrag = (clickedElement: WhiteboardElement, point: Point) => {
    setSelectedElement(clickedElement.id);
    setSelectedElements(new Set());
    if (!canWrite) return; // select-to-inspect only
    setIsDraggingElement(true);
    setDragStartPos(point);
    setDragElementStart(snapshotDragStart(clickedElement));
  };

  // Mouse down with the select tool: drag an element, or start a selection box
  const handleSelectToolMouseDown = (point: Point) => {
    // Don't interrupt if we're editing text. The textarea's own blur ends the
    // edit (and removes an empty element), so only drop the selection here when
    // the click landed outside the element being edited.
    if (editingElement) {
      const editing = elements.find(el => el.id === editingElement);
      if (!editing || !hitTestElement(editing, point, zoom)) {
        setSelectedElement(null);
        setSelectedElements(new Set());
      }
      return;
    }

    // Check if clicking on an element (search in reverse to find topmost element first)
    const clickedElement = [...elements].reverse().find(el => hitTestElement(el, point, zoom));

    if (!clickedElement) {
      // Start selection box
      setIsSelecting(true);
      setSelectionBox({
        startX: point.x,
        startY: point.y,
        endX: point.x,
        endY: point.y
      });
      setSelectedElements(new Set());
      setSelectedElement(null);
      return;
    }

    // Clicking inside a multi-selection drags all selected elements; anything else
    // selects just the clicked element and drags it
    if (selectedElements.size > 1 && selectedElements.has(clickedElement.id)) {
      beginMultiElementDrag(point);
    } else {
      beginSingleElementDrag(clickedElement, point);
    }
  };

  const startStickyNote = (point: Point) => {
    const newSticky: WhiteboardElement = {
      id: Date.now().toString(),
      type: 'sticky',
      x: point.x,
      y: point.y,
      width: 200,
      height: 200,
      text: '',
      color: selectedColor,
      fontSize: fontSize
    };
    addElementWithBroadcast(newSticky);
    setSelectedElement(newSticky.id);
    setSelectedElements(new Set());
    setEditingElement(newSticky.id); // Auto-enter edit mode
    setTool('select');
    setTimeout(addToHistory, 100);
  };

  const startTextElement = (point: Point) => {
    // Clear any selection first
    setSelectedElement(null);
    setSelectedElements(new Set());
    setEditingElement(null);

    const newText: WhiteboardElement = {
      id: Date.now().toString(),
      type: 'text',
      x: point.x,
      y: point.y,
      text: '',
      color: strokeColor,
      fontSize: fontSize
    };

    // Add element and broadcast to other users
    addElementWithBroadcast(newText);

    // Set selection and editing in a timeout to ensure element is rendered
    setTimeout(() => {
      setSelectedElement(newText.id);
      setEditingElement(newText.id);
    }, 0);

    setTool('select');
    setTimeout(addToHistory, 100);
  };

  // Mouse down with a non-select tool
  const handleToolMouseDown = (e: React.MouseEvent, point: Point) => {
    switch (tool) {
      case 'pan':
        beginPan(e);
        break;
      case 'pen':
        setIsDrawing(true);
        setCurrentPath([point]);
        setSelectedElement(null);
        setSelectedElements(new Set());
        break;
      case 'eraser':
        setIsErasing(true);
        setEraserPath([point]);
        // Just process the erasing, don't modify elements unnecessarily
        eraseNow(point, eraserSize);
        setSelectedElement(null);
        setSelectedElements(new Set());
        break;
      case 'rectangle':
      case 'circle':
      case 'arrow':
        setIsDrawing(true);
        setSelectedElement(null);
        setSelectedElements(new Set());
        break;
      case 'sticky':
        startStickyNote(point);
        break;
      case 'text':
        startTextElement(point);
        break;
    }
  };

  // Handle mouse down
  const handleMouseDown = (e: React.MouseEvent) => {
    // Close context menu if open
    if (contextMenu) {
      setContextMenu(null);
    }

    const point = screenToCanvas(e.clientX, e.clientY);
    setStartPoint(point);

    // Check for middle mouse button (button 1) to start panning
    if (e.button === 1) {
      e.preventDefault();
      setIsMiddleMouseDown(true);
      beginPan(e);
      return;
    }

    if (tool !== 'select') {
      // Drawing tools are not offered read-only; only panning is.
      if (canWrite || tool === 'pan') handleToolMouseDown(e, point);
      return;
    }

    // Check if clicking on a resize handle or arrow handle of the selected element
    const selected = selectedElement ? elements.find(el => el.id === selectedElement) : undefined;
    if (canWrite && selected && tryStartHandleDrag(e, point, selected)) return;

    handleSelectToolMouseDown(point);
  };

  // Drag the selected element(s) to follow the pointer
  const dragSelectedElements = (point: Point) => {
    // Nothing to move without a multi-selection or a single selected element
    if (dragElementsStart.size === 0 && !selectedElement) return;
    const deltaX = point.x - dragStartPos.x;
    const deltaY = point.y - dragStartPos.y;
    setElements(applyDragDelta(elements, { dragElementsStart, dragElementStart, selectedElement }, deltaX, deltaY));
  };

  // Drag a rectangle's corner handle to change its border radius
  const dragCornerRadius = (point: Point, handle: CornerHandle, dragStart: CornerRadiusDragStart) => {
    const element = elements.find(el => el.id === selectedElement);
    if (element?.type !== 'rectangle') return;
    const newRadius = computeCornerRadius(element, handle, point, dragStart);
    setElements(patchElement(elements, selectedElement, { borderRadius: newRadius }));
  };

  // Drag a resize handle of the selected element
  const dragResizeHandle = (e: React.MouseEvent, point: Point, handle: ResizeHandle) => {
    const element = elements.find(el => el.id === selectedElement);
    if (!element) return;
    const update = computeResizeUpdate(element, handle, resizeStartSize, point, e.shiftKey, false);
    if (!update) return;
    setElements(patchElement(elements, selectedElement, update));
  };

  // Grow the selection box to the pointer and select whatever it touches
  const dragSelectionBox = (point: Point) => {
    setSelectionBox(prev => prev ? {
      ...prev,
      endX: point.x,
      endY: point.y
    } : null);

    // Update selected elements based on selection box
    if (selectionBox) {
      const box = { ...selectionBox, endX: point.x, endY: point.y };
      const touched = elements.filter(el => isElementInSelectionBox(el, box));
      setSelectedElements(new Set(touched.map(el => el.id)));
    }
  };

  // Erase along the pointer's path
  const dragEraser = (point: Point) => {
    const lastPoint = eraserPath.at(-1);
    if (!lastPoint) {
      // First point
      setEraserPath([point]);
      eraseNow(point, eraserSize);
      return;
    }

    // Interpolate points for smooth erasing
    const interpolated = interpolateEraserPoints(lastPoint, point, eraserSize);
    if (interpolated.length === 0) return;
    interpolated.forEach(interpPoint => eraseBatched(interpPoint, eraserSize));
    setEraserPath(prev => trimEraserPath([...prev, point]));
  };

  // Mouse move while no element/handle drag is in progress
  const handleToolMouseMove = (e: React.MouseEvent, point: Point) => {
    if (isSelecting && tool === 'select') {
      dragSelectionBox(point);
      return;
    }

    if (isDrawing) {
      if (tool === 'pen') {
        setCurrentPath([...currentPath, point]);
      }
      // Store current mouse position for preview
      setCurrentPoint({ ...point, shiftKey: e.shiftKey });
      return;
    }

    if (tool !== 'eraser') return;
    if (isErasing) {
      dragEraser(point);
    }
    // Keep the eraser preview under the cursor
    setCurrentPoint({ ...point, shiftKey: e.shiftKey });
  };

  // Handle mouse move
  const handleMouseMove = (e: React.MouseEvent) => {
    // Handle panning first - doesn't need canvas coordinates
    if (isPanning) {
      const newX = e.clientX - panStart.x;
      const newY = e.clientY - panStart.y;
      const clamped = clampPanPosition(newX, newY, zoom);
      setPanPosition(clamped);
      return;
    }

    // Only calculate canvas coordinates when needed
    const point = screenToCanvas(e.clientX, e.clientY);

    // Broadcast cursor position for real-time collaboration
    if (isConnected) {
      broadcastCursor(point.x, point.y, tool);
    }

    // Handle element dragging
    if (isDraggingElement) {
      dragSelectedElements(point);
      return;
    }

    // Handle corner radius dragging for rectangles
    if (isDraggingCornerRadius && selectedElement && cornerRadiusDragStart) {
      dragCornerRadius(point, isDraggingCornerRadius, cornerRadiusDragStart);
      return;
    }

    if (isResizing && resizeHandle && selectedElement) {
      dragResizeHandle(e, point, resizeHandle);
      return;
    }

    handleToolMouseMove(e, point);
  };

  // Broadcast the final geometry of a dragged element
  const broadcastDraggedElement = (id: string) => {
    const el = elements.find(candidate => candidate.id === id);
    if (el) {
      void broadcastElementUpdate(id, { x: el.x, y: el.y, endX: el.endX, endY: el.endY, points: el.points });
    }
  };

  // Work out which element/connection point a released connection lands on
  const resolveConnectionTarget = (
    point: Point,
    source: { elementId: string }
  ): { element: WhiteboardElement; pointName: ConnectionPointName } | null => {
    // Use the snapped connection point if available (from magnet effect)
    if (hoveredConnectionElement && snappedConnectionPoint) {
      const element = elements.find(el => el.id === hoveredConnectionElement);
      return element ? { element, pointName: snappedConnectionPoint } : null;
    }
    // Fallback: Check all elements except the starting element
    return findConnectionTarget(elements, source.elementId, point, getConnectionPoints);
  };

  // Handle connection drawing completion
  const finishConnectionDrawing = (
    point: Point,
    source: { elementId: string; point: ConnectionPointName; x: number; y: number }
  ) => {
    setIsDrawingConnection(false);

    const target = resolveConnectionTarget(point, source);

    // Create the connected arrow (to the target element, or to the free point when there is none)
    let end: Point | null = null;
    if (target) {
      const targetPoints = getConnectionPoints(target.element);
      end = targetPoints ? targetPoints[target.pointName] : null;
    } else {
      end = connectionEndPoint;
    }
    if (end) {
      const newArrow: WhiteboardElement = {
        id: Date.now().toString(),
        type: 'arrow',
        x: source.x,
        y: source.y,
        endX: end.x,
        endY: end.y,
        strokeColor: strokeColor,
        strokeWidth: 2,
        arrowType: 'arrow',
        startElementId: source.elementId,
        startConnectionPoint: source.point,
        ...(target && { endElementId: target.element.id, endConnectionPoint: target.pointName }),
      };
      setElements([...elements, newArrow]);
      setTimeout(addToHistory, 100);
    }

    setConnectionStart(null);
    setConnectionEndPoint(null);
    setHoveredConnectionElement(null);
    setSnappedConnectionPoint(null);
  };

  // Finish an element drag, resize or corner-radius drag. Returns true when one was in progress.
  const finishActiveDrag = (): boolean => {
    if (isDraggingElement) {
      // Broadcast the final positions of dragged elements
      if (selectedElements.size > 0) {
        selectedElements.forEach(broadcastDraggedElement);
      } else if (selectedElement) {
        broadcastDraggedElement(selectedElement);
      }
      setIsDraggingElement(false);
      setDragElementsStart(new Map()); // Clear multi-element drag state
      setTimeout(addToHistory, 100);
      return true;
    }

    if (isResizing) {
      // Broadcast the final size of resized element
      const el = elements.find(candidate => candidate.id === selectedElement);
      if (selectedElement && el) {
        void broadcastElementUpdate(selectedElement, {
          x: el.x, y: el.y,
          width: el.width, height: el.height,
          radiusX: el.radiusX, radiusY: el.radiusY,
          endX: el.endX, endY: el.endY
        });
      }
      setIsResizing(false);
      setResizeHandle(null);
      setTimeout(addToHistory, 100);
      return true;
    }

    if (isDraggingCornerRadius) {
      // Broadcast corner radius change
      const el = elements.find(candidate => candidate.id === selectedElement);
      if (selectedElement && el) {
        void broadcastElementUpdate(selectedElement, { borderRadius: el.borderRadius });
      }
      setIsDraggingCornerRadius(null);
      setCornerRadiusDragStart(null);
      setTimeout(addToHistory, 100);
      return true;
    }

    return false;
  };

  // Finish drawing a rectangle, circle or arrow by dragging
  const buildDraggedShape = (shiftKey: boolean, point: Point): WhiteboardElement | null => {
    const fillColor = fillMode === 'stroke' ? 'transparent' : selectedColor;
    const outlineColor = fillMode === 'fill' ? 'transparent' : strokeColor;

    switch (tool) {
      case 'rectangle': {
        const { x, y, width, height } = computeRectangleBounds(point, startPoint, shiftKey);
        // Only create rectangle if it has some size (not just a click)
        if (!(width > 5 || height > 5)) return null;
        return {
          id: Date.now().toString(),
          type: 'rectangle',
          x,
          y,
          width,
          height,
          color: fillColor,
          strokeColor: outlineColor,
          strokeWidth: strokeWidth
        };
      }
      case 'circle': {
        // Create ellipse from bounding box (start to end point)
        const { centerX, centerY, radiusX, radiusY } = computeEllipseBounds(point, startPoint, shiftKey);
        // Only create ellipse if it has some size
        if (!(radiusX > 5 || radiusY > 5)) return null;
        return {
          id: Date.now().toString(),
          type: 'circle',
          x: centerX,
          y: centerY,
          radiusX,
          radiusY,
          color: fillColor,
          strokeColor: outlineColor,
          strokeWidth: strokeWidth
        };
      }
      case 'arrow': {
        const length = Math.sqrt(
          Math.pow(point.x - startPoint.x, 2) +
          Math.pow(point.y - startPoint.y, 2)
        );
        // Only create arrow if it has some length
        if (!(length > 5)) return null;
        return {
          id: Date.now().toString(),
          type: 'arrow',
          x: startPoint.x,
          y: startPoint.y,
          endX: point.x,
          endY: point.y,
          strokeColor: strokeColor,
          strokeWidth: strokeWidth,
          arrowType: arrowType
        };
      }
      default:
        return null;
    }
  };

  const finishDrawing = (e: React.MouseEvent, point: Point) => {
    if (tool === 'pen' && currentPath.length > 1) {
      const newPath: WhiteboardElement = {
        id: Date.now().toString(),
        type: 'path',
        x: 0,
        y: 0,
        points: currentPath,
        strokeColor: strokeColor,
        strokeWidth: strokeWidth
      };
      addElementWithBroadcast(newPath);
      setCurrentPath([]);
      setTimeout(addToHistory, 100);
      return;
    }

    const shape = buildDraggedShape(e.shiftKey, point);
    if (shape) {
      addElementWithBroadcast(shape);
      setTimeout(addToHistory, 100);
      setTool('select');
    }
  };

  const finishSelectionBox = () => {
    setIsSelecting(false);
    // Keep the selected elements
    if (selectedElements.size === 1) {
      // If only one element selected, set it as the single selected element
      setSelectedElement(Array.from(selectedElements)[0]);
      setSelectedElements(new Set());
    }
    setSelectionBox(null);
  };

  // Handle mouse up
  const handleMouseUp = (e: React.MouseEvent) => {
    const point = screenToCanvas(e.clientX, e.clientY);

    // Handle arrow handle dragging completion
    if (isDraggingArrowHandle) {
      setIsDraggingArrowHandle(null);
      setArrowDragStart(null);
      setTimeout(addToHistory, 100);
      return; // Don't process other mouse up logic
    }

    // Handle connection drawing completion
    if (isDrawingConnection && connectionStart) {
      finishConnectionDrawing(point, connectionStart);
      return;
    }

    // Handle middle mouse button release
    if (e.button === 1 && isMiddleMouseDown) {
      setIsMiddleMouseDown(false);
      setIsPanning(false);
      return;
    }

    if (finishActiveDrag()) return;

    if (isSelecting && tool === 'select') {
      finishSelectionBox();
    } else if (isDrawing) {
      finishDrawing(e, point);
    }

    // Add to history when finishing erasing
    if (isErasing && tool === 'eraser') {
      setTimeout(addToHistory, 100);
    }

    // Don't reset panning if middle mouse is still down
    if (!isMiddleMouseDown) {
      setIsPanning(false);
    }
    setIsDrawing(false);
    setIsErasing(false);
    setEraserPath([]);
    lastProcessedPoint.current = null;
    setCurrentPoint({ x: 0, y: 0, shiftKey: false });
    setStartPoint({ x: 0, y: 0 });
  };

  // Handle wheel for zoom (pinch/scroll zoom) and panning
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Zoom with Ctrl/Cmd + wheel or pinch gesture
    if (e.ctrlKey || e.metaKey) {
      // Smooth zoom using exponential scaling for natural feel
      const zoomSpeed = 0.003;
      const delta = -e.deltaY * zoomSpeed;

      // Use ref for current zoom to avoid stale closure during rapid events
      const currentZoom = zoomRef.current;
      // Exponential scaling: multiply by e^delta for consistent feel at all zoom levels
      const newScale = Math.min(Math.max(0.025, currentZoom * Math.exp(delta)), 5);
      const scaleRatio = newScale / currentZoom;

      // Update ref immediately for next event
      zoomRef.current = newScale;

      // Get the center of the viewport from cached dimensions
      const { width: viewportWidth, height: viewportHeight } = viewportSizeRef.current;
      const centerX = viewportWidth / 2;
      const centerY = viewportHeight / 2;

      // Adjust pan position so zoom is centered at viewport center
      setPanPosition(prev => {
        const newX = centerX - (centerX - prev.x) * scaleRatio;
        const newY = centerY - (centerY - prev.y) * scaleRatio;
        return clampPanPosition(newX, newY, newScale);
      });

      // Update zoom state in sync with pan to avoid visual mismatch
      setZoom(newScale);

      // Debounce zoom index update (display-only) to reduce renders during rapid zoom
      if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current);
      zoomRafRef.current = requestAnimationFrame(() => {
        const nearestIndex = zoomLevels.reduce((prev, curr, index) => {
          return Math.abs(curr - newScale) < Math.abs(zoomLevels[prev] - newScale) ? index : prev;
        }, 0);
        setZoomIndex(nearestIndex);
        zoomRafRef.current = null;
      });

      // Mark as zooming and debounce the end to disable CSS transition
      if (!isZooming) setIsZooming(true);
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = setTimeout(() => setIsZooming(false), 100);
    } else {
      // Pan with regular scroll (no modifier keys)
      // Normalize delta for consistent behavior across browsers/devices
      let deltaX = e.deltaX;
      let deltaY = e.deltaY;

      // Handle different delta modes (pixels, lines, pages)
      if (e.deltaMode === 1) {
        // Line mode - multiply by line height
        deltaX *= 20;
        deltaY *= 20;
      } else if (e.deltaMode === 2) {
        // Page mode - multiply by page size
        deltaX *= 100;
        deltaY *= 100;
      }

      setPanPosition(prev => {
        const newX = prev.x - deltaX;
        const newY = prev.y - deltaY;
        return clampPanPosition(newX, newY, zoomRef.current);
      });
    }
  }, [clampPanPosition, isZooming]);

  // Touch state refs for mobile support
  const touchStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const lastTouchDistanceRef = useRef<number | null>(null);
  const lastTouchCenterRef = useRef<{ x: number; y: number } | null>(null);
  const isTouchPanningRef = useRef(false);
  const [isTouchActive, setIsTouchActive] = useState(false); // State to disable transitions during touch

  // Screen touch -> canvas coordinates (null until the canvas is mounted)
  const touchToCanvasPoint = useCallback((touch: TouchPoint): Point | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: (touch.clientX - rect.left - panPosition.x) / zoom,
      y: (touch.clientY - rect.top - panPosition.y) / zoom,
    };
  }, [panPosition, zoom]);

  // Select tool: pick the touched element and start dragging it, or deselect
  const beginTouchSelect = useCallback((point: Point) => {
    // Find element at touch position
    const touchedElement = [...elements].reverse().find(el => hitTestElement(el, point, zoom, TOUCH_LINE_TOLERANCE));

    if (!touchedElement) {
      // Touched empty space - deselect
      setSelectedElement(null);
      setSelectedElements(new Set());
      return;
    }

    // Select and start dragging the element
    setSelectedElement(touchedElement.id);
    setSelectedElements(new Set());
    if (!canWrite) return; // select-to-inspect only
    setIsDraggingElement(true);
    setDragStartPos(point);
    setDragElementStart(snapshotDragStart(touchedElement));
  }, [canWrite, elements, zoom]);

  // Start drawing/placing based on the active tool
  const beginTouchTool = useCallback((point: Point) => {
    if (tool === 'select') {
      beginTouchSelect(point);
      return;
    }
    if (!canWrite) return;
    if (tool !== 'rectangle' && tool !== 'circle' && tool !== 'arrow' && tool !== 'pen') return;

    setIsDrawing(true);
    if (tool === 'pen') setCurrentPath([{ x: point.x, y: point.y }]);
    setSelectedElement(null);
    setSelectedElements(new Set());
  }, [canWrite, tool, beginTouchSelect]);

  const beginSingleTouch = useCallback((touch: React.Touch) => {
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      panX: panPosition.x,
      panY: panPosition.y,
    };

    // For pan tool, use touch panning directly
    // For other tools, set up for drawing via screenToCanvas
    if (tool === 'pan') {
      isTouchPanningRef.current = true;
      return;
    }
    isTouchPanningRef.current = false;

    // Calculate canvas point and set start point for drawing
    const point = touchToCanvasPoint(touch);
    if (!point) return;
    setStartPoint(point);
    beginTouchTool(point);
  }, [panPosition, tool, touchToCanvasPoint, beginTouchTool]);

  // Two touches - prepare for pinch-to-zoom
  const beginPinch = useCallback((touch1: React.Touch, touch2: React.Touch) => {
    isTouchPanningRef.current = false;
    setIsDrawing(false); // Cancel any drawing in progress

    // Initial distance and center point between touches
    lastTouchDistanceRef.current = touchDistance(touch1, touch2);
    lastTouchCenterRef.current = touchMidpoint(touch1, touch2);
  }, []);

  // Handle touch start - for mobile panning and pinch-to-zoom
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Only handle pure touch events
    if (!e.touches.length) return;

    // Prevent default to stop mouse event simulation on touch devices
    e.preventDefault();
    setIsTouchActive(true); // Disable transitions during touch

    if (e.touches.length === 1) {
      beginSingleTouch(e.touches[0]);
    } else if (e.touches.length === 2) {
      beginPinch(e.touches[0], e.touches[1]);
    }
  }, [beginSingleTouch, beginPinch]);

  // Pan mode - move the canvas
  const panWithTouch = useCallback((touch: React.Touch, start: { x: number; y: number; panX: number; panY: number }) => {
    const newX = start.panX + (touch.clientX - start.x);
    const newY = start.panY + (touch.clientY - start.y);
    setPanPosition(clampPanPosition(newX, newY, zoom));
  }, [clampPanPosition, zoom]);

  // Handle element dragging or drawing tools
  const dragOrDrawWithTouch = useCallback((touch: React.Touch) => {
    const point = touchToCanvasPoint(touch);
    if (!point) return;

    // Handle element dragging (select tool)
    if (isDraggingElement && selectedElement) {
      const deltaX = point.x - dragStartPos.x;
      const deltaY = point.y - dragStartPos.y;
      setElements(prev => prev.map(el =>
        el.id === selectedElement ? translateFromStart(el, dragElementStart, deltaX, deltaY) : el
      ));
    } else if (tool === 'pen' && isDrawing) {
      // Pen drawing
      setCurrentPath(prev => [...prev, { x: point.x, y: point.y }]);
      setCurrentPoint({ x: point.x, y: point.y, shiftKey: false });
    } else if (isDrawing) {
      // Update current point for rectangle/circle/arrow preview
      setCurrentPoint({ x: point.x, y: point.y, shiftKey: false });
    }
  }, [touchToCanvasPoint, isDraggingElement, selectedElement, dragStartPos, dragElementStart, tool, isDrawing]);

  // Two touches - pinch-to-zoom
  const pinchZoomWithTouches = useCallback((touch1: React.Touch, touch2: React.Touch, lastDistance: number) => {
    // Calculate zoom delta from the change in distance between touches
    const newDistance = touchDistance(touch1, touch2);
    const scale = newDistance / lastDistance;
    const newZoom = Math.min(Math.max(0.025, zoom * scale), 5);

    const center = touchMidpoint(touch1, touch2);

    // Adjust pan position to zoom towards the center point
    const rect = canvasRef.current?.getBoundingClientRect();
    if (lastTouchCenterRef.current && rect) {
      const scaleRatio = newZoom / zoom;
      const canvasCenterX = center.x - rect.left;
      const canvasCenterY = center.y - rect.top;

      setPanPosition(prev => {
        const newX = canvasCenterX - (canvasCenterX - prev.x) * scaleRatio;
        const newY = canvasCenterY - (canvasCenterY - prev.y) * scaleRatio;
        return clampPanPosition(newX, newY, newZoom);
      });
    }

    // Update zoom
    setZoomIndex(nearestZoomIndex(newZoom));
    zoomRef.current = newZoom;
    setZoom(newZoom);

    // Update refs for next move
    lastTouchDistanceRef.current = newDistance;
    lastTouchCenterRef.current = center;
  }, [zoom, clampPanPosition]);

  // Handle touch move - pan canvas, pinch-to-zoom, or drawing
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1 && touchStartRef.current) {
      e.preventDefault();
      if (isTouchPanningRef.current) {
        panWithTouch(e.touches[0], touchStartRef.current);
      } else {
        dragOrDrawWithTouch(e.touches[0]);
      }
    } else if (e.touches.length === 2 && lastTouchDistanceRef.current !== null) {
      e.preventDefault();
      pinchZoomWithTouches(e.touches[0], e.touches[1], lastTouchDistanceRef.current);
    }
  }, [panWithTouch, dragOrDrawWithTouch, pinchZoomWithTouches]);

  // All touches ended while drawing - create the shape for the active tool
  const finishTouchDrawing = useCallback((touch: React.Touch | undefined) => {
    const end = touch ? touchToCanvasPoint(touch) : null;
    if (!end) return;

    const newElement = createElementFromTouch(tool, startPoint, end, currentPath, {
      fillMode,
      selectedColor,
      strokeColor,
      strokeWidth,
      arrowType,
    });
    if (!newElement) return;

    setElements(prev => [...prev, newElement]);
    addToHistory();
  }, [touchToCanvasPoint, tool, startPoint, currentPath, fillMode, selectedColor, strokeColor, strokeWidth, arrowType, addToHistory]);

  // Handle touch end - finalize drawing, dragging, or end panning
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 0) {
      // Handle element dragging completion
      if (isDraggingElement) {
        setIsDraggingElement(false);
        addToHistory();
      }

      // All touches ended - finalize drawing if we were drawing
      if (!isTouchPanningRef.current && touchStartRef.current && isDrawing) {
        finishTouchDrawing(e.changedTouches[0]);
      }

      // Reset states
      setIsDrawing(false);
      setCurrentPath([]);
      setCurrentPoint({ x: 0, y: 0, shiftKey: false });
      setStartPoint({ x: 0, y: 0 });
      touchStartRef.current = null;
      lastTouchDistanceRef.current = null;
      lastTouchCenterRef.current = null;
      isTouchPanningRef.current = false;
      setIsTouchActive(false); // Re-enable transitions
    } else if (e.touches.length === 1) {
      // One touch remaining - switch to panning mode
      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        panX: panPosition.x,
        panY: panPosition.y,
      };
      lastTouchDistanceRef.current = null;
      lastTouchCenterRef.current = null;
      isTouchPanningRef.current = true;
    }
  }, [panPosition, isDrawing, isDraggingElement, addToHistory, finishTouchDrawing]);

  // Handle right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    const point = screenToCanvas(e.clientX, e.clientY);

    // Find if we clicked on an element
    const clickedElement = [...elements].reverse().find(el => {
      switch (el.type) {
        case 'rectangle':
        case 'sticky':
          return point.x >= el.x && point.x <= el.x + (el.width || 0) &&
                 point.y >= el.y && point.y <= el.y + (el.height || 0);
        case 'circle':
          {
const ctxRx = el.radiusX ?? el.radius ?? 50;
          const ctxRy = el.radiusY ?? el.radius ?? 50;
          // Ellipse equation check
          const ctxNormDist = Math.pow(point.x - el.x, 2) / (ctxRx * ctxRx) + Math.pow(point.y - el.y, 2) / (ctxRy * ctxRy);
          return ctxNormDist <= 1;
          }
        case 'text':
          {
const textWidth = Math.max(100, (el.text?.length || 0) * (el.fontSize || 16) * 0.6);
          const textHeight = (el.fontSize || 16) * 1.5;
          return point.x >= el.x && point.x <= el.x + textWidth &&
                 point.y >= el.y - textHeight && point.y <= el.y;
          }
        case 'arrow': {
          // Tolerance scales with zoom so the clickable strip stays ~12px
          // wide on screen regardless of zoom level.
          const ctxHitTolerance = 12 / zoom;
          const lineLength = Math.sqrt(
            Math.pow((el.endX || el.x) - el.x, 2) +
            Math.pow((el.endY || el.y) - el.y, 2)
          );
          if (lineLength === 0) return false;
          const t = Math.max(0, Math.min(1, (
            (point.x - el.x) * ((el.endX || el.x) - el.x) +
            (point.y - el.y) * ((el.endY || el.y) - el.y)
          ) / (lineLength * lineLength)));
          const projX = el.x + t * ((el.endX || el.x) - el.x);
          const projY = el.y + t * ((el.endY || el.y) - el.y);
          const distToLine = Math.sqrt(Math.pow(point.x - projX, 2) + Math.pow(point.y - projY, 2));
          return distToLine <= ctxHitTolerance;
        }
        case 'path': {
          if (!el.points || el.points.length < 2) return false;
          const ctxHitTolerance = 12 / zoom;
          for (let i = 0; i < el.points.length - 1; i++) {
            const p1 = el.points[i];
            const p2 = el.points[i + 1];
            const segLength = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
            if (segLength === 0) continue;
            const segT = Math.max(0, Math.min(1, (
              (point.x - p1.x) * (p2.x - p1.x) +
              (point.y - p1.y) * (p2.y - p1.y)
            ) / (segLength * segLength)));
            const segProjX = p1.x + segT * (p2.x - p1.x);
            const segProjY = p1.y + segT * (p2.y - p1.y);
            const segDist = Math.sqrt(Math.pow(point.x - segProjX, 2) + Math.pow(point.y - segProjY, 2));
            if (segDist <= ctxHitTolerance) return true;
          }
          return false;
        }
        default:
          return false;
      }
    });

    if (clickedElement) {
      setSelectedElement(clickedElement.id);
      setSelectedElements(new Set());
      // Every menu action edits the board, so read-only viewers get no menu.
      setContextMenu(canWrite ? {
        x: e.clientX,
        y: e.clientY,
        elementId: clickedElement.id
      } : null);
    } else {
      setContextMenu(null);
    }
  }, [canWrite, elements, screenToCanvas, zoom]);

  // Context menu actions
  const bringToFront = useCallback(() => {
    if (!canWrite || !contextMenu) return;
    const elementIndex = elements.findIndex(el => el.id === contextMenu.elementId);
    if (elementIndex === -1) return;
    const element = elements[elementIndex];
    const newElements = [...elements];
    newElements.splice(elementIndex, 1);
    newElements.push(element);
    setElements(newElements);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [canWrite, contextMenu, elements, addToHistory]);

  const sendToBack = useCallback(() => {
    if (!canWrite || !contextMenu) return;
    const elementIndex = elements.findIndex(el => el.id === contextMenu.elementId);
    if (elementIndex === -1) return;
    const element = elements[elementIndex];
    const newElements = [...elements];
    newElements.splice(elementIndex, 1);
    newElements.unshift(element);
    setElements(newElements);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [canWrite, contextMenu, elements, addToHistory]);

  const bringForward = useCallback(() => {
    if (!canWrite || !contextMenu) return;
    const elementIndex = elements.findIndex(el => el.id === contextMenu.elementId);
    if (elementIndex === -1 || elementIndex === elements.length - 1) return;
    const newElements = [...elements];
    [newElements[elementIndex], newElements[elementIndex + 1]] = [newElements[elementIndex + 1], newElements[elementIndex]];
    setElements(newElements);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [canWrite, contextMenu, elements, addToHistory]);

  const sendBackward = useCallback(() => {
    if (!canWrite || !contextMenu) return;
    const elementIndex = elements.findIndex(el => el.id === contextMenu.elementId);
    if (elementIndex <= 0) return;
    const newElements = [...elements];
    [newElements[elementIndex], newElements[elementIndex - 1]] = [newElements[elementIndex - 1], newElements[elementIndex]];
    setElements(newElements);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [canWrite, contextMenu, elements, addToHistory]);

  const copyElement = useCallback(() => {
    // Copy from context menu, selected elements (multi), or single selected element
    if (contextMenu?.elementId) {
      const element = elements.find(el => el.id === contextMenu.elementId);
      if (element) {
        setClipboard([{ ...element }]);
      }
    } else if (selectedElements.size > 0) {
      // Copy all selected elements
      const elementsToCopy = elements.filter(el => selectedElements.has(el.id));
      setClipboard(elementsToCopy.map(el => ({ ...el })));
    } else if (selectedElement) {
      const element = elements.find(el => el.id === selectedElement);
      if (element) {
        setClipboard([{ ...element }]);
      }
    }
    setContextMenu(null);
  }, [contextMenu, selectedElement, selectedElements, elements]);

  const pasteElement = useCallback(() => {
    if (!canWrite || clipboard.length === 0) return;

    const newElements: WhiteboardElement[] = clipboard.map((el, index) => ({
      ...el,
      id: `${Date.now()}-${index}`,
      x: el.x + 20,
      y: el.y + 20,
      ...(el.type === 'arrow' && el.endX && el.endY ? {
        endX: el.endX + 20,
        endY: el.endY + 20,
      } : {}),
      ...(el.type === 'path' && el.points ? {
        points: el.points.map(p => ({ x: p.x + 20, y: p.y + 20 })),
      } : {}),
    }));

    setElements([...elements, ...newElements]);

    // Select all pasted elements
    if (newElements.length === 1) {
      setSelectedElement(newElements[0].id);
      setSelectedElements(new Set());
    } else {
      setSelectedElement(null);
      setSelectedElements(new Set(newElements.map(el => el.id)));
    }

    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [canWrite, clipboard, elements, addToHistory]);

  const duplicateElement = useCallback(() => {
    if (!canWrite || !contextMenu) return;
    const element = elements.find(el => el.id === contextMenu.elementId);
    if (!element) return;
    const newElement: WhiteboardElement = {
      ...element,
      id: Date.now().toString(),
      x: element.x + 20,
      y: element.y + 20,
      ...(element.type === 'arrow' && element.endX && element.endY ? {
        endX: element.endX + 20,
        endY: element.endY + 20,
      } : {}),
      ...(element.type === 'path' && element.points ? {
        points: element.points.map(p => ({ x: p.x + 20, y: p.y + 20 })),
      } : {}),
    };
    setElements([...elements, newElement]);
    setSelectedElement(newElement.id);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [canWrite, contextMenu, elements, addToHistory]);

  const deleteElement = useCallback(() => {
    if (!canWrite || !contextMenu) return;
    deleteElementWithBroadcast(contextMenu.elementId);
    setSelectedElement(null);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [canWrite, contextMenu, deleteElementWithBroadcast, addToHistory]);

  // Close context menu when clicking elsewhere
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      window.addEventListener('click', handleClick);
      return () => window.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  // Delete selected element(s)
  const deleteSelectedElement = useCallback(() => {
    if (!canWrite) return;
    if (selectedElements.size > 0) {
      // Delete multiple elements and broadcast
      selectedElements.forEach(id => {
        if (isConnected) {
          void broadcastElementDelete(id);
        }
      });
      setElements(elements.filter(el => !selectedElements.has(el.id)));
      setSelectedElements(new Set());
      setTimeout(addToHistory, 100);
    } else if (selectedElement) {
      deleteElementWithBroadcast(selectedElement);
      setSelectedElement(null);
      setTimeout(addToHistory, 100);
    }
  }, [canWrite, selectedElements, selectedElement, isConnected, broadcastElementDelete, elements, addToHistory, deleteElementWithBroadcast]);

  // Duplicate the multi-selection, or the single selected element, next to the
  // originals. Returns whether there was a selection to duplicate.
  const duplicateSelection = useCallback((): boolean => {
    if (!canWrite) return false;
    if (selectedElements.size > 0) {
      // Duplicate multiple selected elements
      const newElements = elements
        .filter(el => selectedElements.has(el.id))
        .map((el, index) => createOffsetCopy(el, `${Date.now()}-${index}`));
      setElements([...elements, ...newElements]);
      setSelectedElement(null);
      setSelectedElements(new Set(newElements.map(el => el.id)));
      setTimeout(addToHistory, 100);
      return true;
    }

    if (!selectedElement) return false;

    // Duplicate single selected element
    const element = elements.find(el => el.id === selectedElement);
    if (element) {
      const newElement = createOffsetCopy(element, Date.now().toString());
      setElements([...elements, newElement]);
      setSelectedElement(newElement.id);
      setTimeout(addToHistory, 100);
    }
    return true;
  }, [canWrite, selectedElement, selectedElements, elements, addToHistory]);

  // Move the selected element to the front (or back) of the stacking order.
  // Returns whether there was a selected element.
  const reorderSelectedElement = useCallback((toFront: boolean): boolean => {
    if (!canWrite || !selectedElement) return false;

    const elementIndex = elements.findIndex(el => el.id === selectedElement);
    const canMove = toFront
      ? elementIndex !== -1 && elementIndex !== elements.length - 1
      : elementIndex > 0;
    if (canMove) {
      const newElements = [...elements];
      const [element] = newElements.splice(elementIndex, 1);
      if (toFront) {
        newElements.push(element);
      } else {
        newElements.unshift(element);
      }
      setElements(newElements);
      setTimeout(addToHistory, 100);
    }
    return true;
  }, [canWrite, selectedElement, elements, addToHistory]);

  // Cmd/Ctrl + key shortcuts. Returns whether the key was handled (so the
  // browser default should be suppressed).
  const runModShortcut = useCallback((key: string): boolean => {
    switch (key) {
      case 'c': // Copy
        if (!selectedElement && selectedElements.size === 0) return false;
        copyElement();
        return true;
      case 'v': // Paste
        if (clipboard.length === 0) return false;
        pasteElement();
        return true;
      case 'd': // Duplicate
        return duplicateSelection();
      case ']': // Bring to front
        return reorderSelectedElement(true);
      case '[': // Send to back
        return reorderSelectedElement(false);
      case 'a': // Select all
        setSelectedElements(new Set(elements.map(el => el.id)));
        setSelectedElement(null);
        return true;
      default:
        return false;
    }
  }, [selectedElement, selectedElements, clipboard, elements, copyElement, pasteElement, duplicateSelection, reorderSelectedElement]);

  // Escape: deselect all and reset tool to select
  const resetToSelectTool = useCallback(() => {
    setSelectedElement(null);
    setSelectedElements(new Set());
    setContextMenu(null);
    setTool('select');
    setIsDrawing(false);
    setIsErasing(false);
    setCurrentPath([]);
    // Remove focus from any focused element (toolbar buttons, etc.)
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  // Keyboard shortcuts for copy, paste, delete, duplicate
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when editing text
      if (editingElement) return;

      // Don't trigger shortcuts when typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

      // Copy, paste, duplicate, z-order and select-all: Cmd/Ctrl + C/V/D/]/[/A
      if (cmdOrCtrl && runModShortcut(e.key)) {
        e.preventDefault();
      }

      // Delete: Backspace or Delete
      if ((e.key === 'Backspace' || e.key === 'Delete') && (selectedElement || selectedElements.size > 0)) {
        e.preventDefault();
        deleteSelectedElement();
      }

      if (e.key === 'Escape') {
        resetToSelectTool();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedElement, selectedElements, editingElement, runModShortcut, deleteSelectedElement, resetToSelectTool]);

  // Cleanup eraser paths periodically for performance
  useEffect(() => {
    const interval = setInterval(() => {
      // Consolidate and simplify erased paths
      setElements(prev => prev.map(element => consolidateErasedPaths(element)));
    }, 5000); // Run every 5 seconds

    return () => clearInterval(interval);
  }, []);

  // Zoom one stop in (+1) or out (-1), keeping the viewport center fixed
  const stepZoom = useCallback((direction: 1 | -1) => {
    // Use the tracked index directly
    const newIndex = zoomIndex + direction;
    if (newIndex < 0 || newIndex >= zoomLevels.length) return;

    const newScale = zoomLevels[newIndex];
    const scaleRatio = newScale / zoom;

    // Get viewport center
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      // Adjust pan to zoom towards viewport center
      setPanPosition(prev => {
        const newX = centerX - (centerX - prev.x) * scaleRatio;
        const newY = centerY - (centerY - prev.y) * scaleRatio;
        return clampPanPosition(newX, newY, newScale);
      });
    }

    setZoomIndex(newIndex);
    zoomRef.current = newScale;
    setZoom(newScale);
    setIsZooming(true);
    if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    zoomTimeoutRef.current = setTimeout(() => setIsZooming(false), 200);
  }, [zoomIndex, zoom, clampPanPosition]);

  // Reset to 100% with the canvas origin centered in the viewport
  const resetZoom = useCallback(() => {
    zoomRef.current = 1;
    setZoom(1);
    setZoomIndex(8); // Index 8 = 100%
    const { width: vw, height: vh } = viewportSizeRef.current;
    setPanPosition({ x: vw / 2, y: vh / 2 });
  }, []);

  // Zoom shortcuts - snap to discrete zoom levels
  const handleZoomShortcut = useCallback((e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;

    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      stepZoom(1);
    } else if (e.key === '-') {
      e.preventDefault();
      stepZoom(-1);
    } else if (e.key === '0') {
      e.preventDefault();
      resetZoom();
    }
  }, [stepZoom, resetZoom]);

  // Undo/redo, delete, escape and space-to-pan shortcuts
  const handleEditShortcut = useCallback((e: KeyboardEvent) => {
    const isModKey = e.metaKey || e.ctrlKey;
    const isRedo = e.key === 'y' || (e.key === 'z' && e.shiftKey);

    if (isModKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (isModKey && isRedo) {
      e.preventDefault();
      redo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelectedElement();
    } else if (e.key === 'Escape') {
      setSelectedElement(null);
      setSelectedElements(new Set());
      setSelectionBox(null);
      setIsSelecting(false);
      setTool('select');
    } else if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      setTool('pan');
    }
  }, [undo, redo, deleteSelectedElement]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip most shortcuts when editing text (allow Escape to exit editing)
      if (editingElement) {
        if (e.key === 'Escape') {
          setEditingElement(null);
        }
        return;
      }

      handleEditShortcut(e);
      handleZoomShortcut(e);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        setTool('select');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [editingElement, handleEditShortcut, handleZoomShortcut]);

  // Select a single element (clearing any multi-selection)
  const selectSingleElement = (elementId: string) => {
    setSelectedElement(elementId);
    setSelectedElements(new Set());
  };

  // Fill/stroke for SVG shapes: 'transparent' means no paint at all
  const toSvgPaint = (color: string | undefined) => (color === 'transparent' ? 'none' : displayColor(color));

  // Update an element's text as the user types
  const updateElementText = (elementId: string, text: string) => {
    const updated = elements.map(el =>
      el.id === elementId ? { ...el, text } : el
    );
    setElements(updated);
  };

  // Start dragging a new arrow connection out of an element's connection point
  const beginConnection = (elementId: string, name: ConnectionPointName, position: Point) => {
    setIsDrawingConnection(true);
    setConnectionStart({ elementId, point: name, x: position.x, y: position.y });
    setConnectionEndPoint(position);
  };

  // Draggable connection points of a selected element
  const renderConnectionHandles = (element: WhiteboardElement, isTextElement = false) => {
    const points = getConnectionPoints(element);
    if (!points) return null;
    return (
      <ConnectionHandles
        points={points}
        isTextElement={isTextElement}
        onStart={(name, position) => beginConnection(element.id, name, position)}
      />
    );
  };

  // Connection points shown when hovering during connection drawing
  const renderConnectionHover = (element: WhiteboardElement) => {
    if (!isDrawingConnection || hoveredConnectionElement !== element.id) return null;
    const points = getConnectionPoints(element);
    if (!points) return null;
    return <ConnectionHoverPoints points={points} snappedPoint={snappedConnectionPoint} />;
  };

  const renderRectangleElement = (element: WhiteboardElement) => {
    const width = element.width || 0;
    const height = element.height || 0;
    const radius = element.borderRadius || 0;

    return (
      <>
        <rect
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
          rx={radius}
          ry={radius}
          fill={toSvgPaint(element.color)}
          stroke={toSvgPaint(element.strokeColor)}
          strokeWidth={element.strokeWidth || strokeWidth}
          className="cursor-pointer"
          onClick={() => selectSingleElement(element.id)}
        />
        {/* Selection border for single selection */}
        {selectedElement === element.id && (
          <>
            <rect
              x={element.x}
              y={element.y}
              width={width}
              height={height}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={1.5}
              rx={element.borderRadius || 2}
              ry={element.borderRadius || 2}
              pointerEvents="none"
            />
            {/* Resize handles */}
            <ResizeHandles left={element.x} top={element.y} right={element.x + width} bottom={element.y + height} />
            {/* Corner radius handles - inside corners */}
            <CornerRadiusHandles
              x={element.x}
              y={element.y}
              width={width}
              height={height}
              radius={radius}
              onDragStart={(corner, e) => {
                setIsDraggingCornerRadius(corner);
                const point = screenToCanvas(e.clientX, e.clientY);
                setCornerRadiusDragStart({ x: point.x, y: point.y, initialRadius: radius });
              }}
            />
            {/* Connection points */}
            {renderConnectionHandles(element)}
          </>
        )}
        {renderConnectionHover(element)}
      </>
    );
  };

  const renderCircleElement = (element: WhiteboardElement) => {
    // Support both legacy radius and new radiusX/radiusY for ellipses
    const { rx: ellipseRx, ry: ellipseRy } = getEllipseRadii(element);

    return (
      <>
        <ellipse
          cx={element.x}
          cy={element.y}
          rx={ellipseRx}
          ry={ellipseRy}
          fill={toSvgPaint(element.color)}
          stroke={toSvgPaint(element.strokeColor)}
          strokeWidth={element.strokeWidth || strokeWidth}
          className="cursor-pointer"
          onClick={() => selectSingleElement(element.id)}
        />
        {/* Selection border for single selection */}
        {selectedElement === element.id && (
          <>
            <rect
              x={element.x - ellipseRx}
              y={element.y - ellipseRy}
              width={ellipseRx * 2}
              height={ellipseRy * 2}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={1.5}
              rx={2}
              ry={2}
              pointerEvents="none"
            />
            {/* Resize handles */}
            <ResizeHandles
              left={element.x - ellipseRx}
              top={element.y - ellipseRy}
              right={element.x + ellipseRx}
              bottom={element.y + ellipseRy}
            />
            {/* Connection points */}
            {renderConnectionHandles(element)}
          </>
        )}
        {renderConnectionHover(element)}
      </>
    );
  };

  // Text being edited in place
  const handleTextBlur = (e: React.FocusEvent<HTMLTextAreaElement>, elementId: string) => {
    // Don't close if clicking within the toolbar
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (relatedTarget?.closest('.fixed.z-50')) {
      return;
    }
    // Remove text element if empty (check the actual textarea value)
    const textValue = (e.target as HTMLTextAreaElement).value;
    if (!textValue || textValue.trim() === '') {
      deleteElementWithBroadcast(elementId);
      setSelectedElement(null);
    } else {
      // Broadcast text change
      void broadcastElementUpdate(elementId, { text: textValue });
    }
    setEditingElement(null);
    setTimeout(addToHistory, 100);
  };

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, elementId: string) => {
    e.stopPropagation();
    if (e.key !== 'Escape') return;

    // Remove text element if empty when pressing Escape
    const textValue = (e.target as HTMLTextAreaElement).value;
    if (!textValue || textValue.trim() === '') {
      setElements(prev => prev.filter(el => el.id !== elementId));
      setSelectedElement(null);
    }
    setEditingElement(null);
  };

  const renderTextEditor = (element: WhiteboardElement, textFontSize: number) => {
    const textElementLines = (element.text || '').split('\n');
    const maxLineLength = Math.max(...textElementLines.map(line => line.length), 1);
    const estimatedTextWidth = Math.max(200, maxLineLength * textFontSize * 0.7 + 40);
    const textAreaHeight = Math.max(textFontSize * 2, textElementLines.length * textFontSize * 1.5 + 20);

    return (
      <foreignObject
        x={element.x}
        y={element.y - textFontSize}
        width={estimatedTextWidth}
        height={textAreaHeight}
        style={{ pointerEvents: 'auto', overflow: 'visible' }}
      >
        <textarea
          ref={(textarea) => focusTextareaAtEnd(textarea)}
          placeholder={st('sweep.weldflow.whiteboardView.typeSomethingPlaceholder')}
          className="bg-transparent border-none outline-none resize-none placeholder:text-gray-400"
          style={{
            fontSize: textFontSize,
            color: displayColor(element.color),
            width: '100%',
            height: '100%',
            padding: '0',
            margin: '0',
            lineHeight: `${textFontSize * 1.5}px`,
            background: 'transparent',
            border: 'none',
            caretColor: displayColor(element.color),
            fontWeight: element.fontWeight || 'normal',
            fontStyle: element.fontStyle || 'normal',
            textDecoration: element.textDecoration || 'none',
            fontFamily: 'inherit',
          }}
          value={element.text || ''}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => updateElementText(element.id, e.target.value)}
          onBlur={(e) => handleTextBlur(e, element.id)}
          onKeyDown={(e) => handleTextKeyDown(e, element.id)}
        />
      </foreignObject>
    );
  };

  // Start dragging a text element (or follow its link on Ctrl+click)
  const handleTextMouseDown = (e: React.MouseEvent<SVGRectElement>, element: WhiteboardElement) => {
    e.stopPropagation();
    if (element.link && e.ctrlKey) {
      window.open(element.link, '_blank');
      return;
    }
    const point = screenToCanvas(e.clientX, e.clientY);
    setSelectedElement(element.id);
    setSelectedElements(new Set());
    if (!canWrite) return; // select-to-inspect only
    setIsDraggingElement(true);
    setDragStartPos(point);
    setDragElementStart({ x: element.x || 0, y: element.y || 0 });
  };

  // Size the text hit area (and selection rect) to the measured text, and
  // publish the measured bounds for arrow connections and the toolbar
  const syncTextHitArea = (node: SVGRectElement | null, element: WhiteboardElement) => {
    if (!node) return;

    // Get the text element's bounding box to size the hit area
    const textEl = node.parentElement?.querySelector('text');
    if (!textEl) return;
    const bbox = textEl.getBBox();
    setPaddedBounds(node, bbox, 6, 4);

    // Also update selection rect if present (for single or multi selection)
    const selRect = node.parentElement?.querySelector('.selection-rect') as SVGRectElement;
    if (selRect) {
      setPaddedBounds(selRect, bbox, 6, 4);
    }

    // Store bounding box in ref for arrow connection positioning
    if (!areBoundsEqual(textBoundingBoxesRef.current.get(element.id), bbox)) {
      textBoundingBoxesRef.current.set(element.id, {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height
      });
      // Trigger arrow position update
      setTextBboxVersion(v => v + 1);
    }

    // Update connection points positions
    positionTextConnectionPoints(node.parentElement, bbox);

    // Store bounding box for toolbar positioning (only for single selection to avoid infinite loop)
    const isSingleSelection = selectedElement === element.id && !selectedElements.has(element.id);
    if (isSingleSelection && !areBoundsEqual(textBoundingBox, bbox)) {
      setTextBoundingBox({ x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height });
    }
  };

  const renderTextLabel = (element: WhiteboardElement, textFontSize: number) => (
    <text
      x={element.x}
      y={element.y}
      fill={element.text ? displayColor(element.color) : '#9ca3af'}
      fontSize={textFontSize}
      fontWeight={element.fontWeight || 'normal'}
      fontStyle={element.text ? (element.fontStyle || 'normal') : 'italic'}
      textDecoration={element.textDecoration || 'none'}
      textAnchor={getTextAnchor(element.textAlign)}
      className="pointer-events-none select-none"
      style={element.link ? { textDecoration: 'underline' } : {}}
    >
      {textLines(element.text || st('sweep.weldflow.whiteboardView.typeSomethingPlaceholder')).map(({ offset, line }) => (
        <tspan
          key={offset}
          x={element.x}
          dy={offset === 0 ? 0 : textFontSize * 1.5}
        >
          {line || ' '}
        </tspan>
      ))}
    </text>
  );

  const renderTextDisplay = (element: WhiteboardElement, textFontSize: number) => (
    <>
      {/* Invisible hit area - always present for clicking/dragging */}
      <rect
        className="hit-area cursor-move"
        x={element.x - 6}
        y={element.y - textFontSize - 4}
        width={30}
        height={textFontSize + 8}
        fill="transparent"
        stroke="none"
        onMouseDown={(e) => handleTextMouseDown(e, element)}
        onDoubleClick={() => { if (canWrite) setEditingElement(element.id); }}
        ref={(node) => syncTextHitArea(node, element)}
      />
      {renderTextLabel(element, textFontSize)}
      {/* Selection border - visible when single or multi selected */}
      {(selectedElement === element.id || selectedElements.has(element.id)) && (
        <rect
          className="selection-rect pointer-events-none"
          x={element.x - 6}
          y={element.y - textFontSize - 4}
          width={30}
          height={textFontSize + 8}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.5}
          rx={4}
          ry={4}
        />
      )}
      {/* Connection points for text */}
      {selectedElement === element.id && renderConnectionHandles(element, true)}
      {renderConnectionHover(element)}
    </>
  );

  const renderTextElement = (element: WhiteboardElement) => {
    const textFontSize = element.fontSize || 16;

    return (
      <g>
        {editingElement === element.id
          ? renderTextEditor(element, textFontSize)
          : renderTextDisplay(element, textFontSize)}
      </g>
    );
  };

  const renderStickyElement = (element: WhiteboardElement) => {
    // Use stored height if available, otherwise calculate based on text content
    const textLines = (element.text || '').split('\n');
    const lineHeight = (element.fontSize || 16) * 1.5;
    const minHeight = 200;
    const padding = 24; // p-3 = 12px top + 12px bottom
    const autoCalculatedHeight = Math.max(minHeight, (textLines.length * lineHeight) + padding + 20);
    const stickyHeight = element.height || autoCalculatedHeight;
    const isEditing = editingElement === element.id;

    return (
      <g>
        <rect
          x={element.x}
          y={element.y}
          width={element.width}
          height={stickyHeight}
          fill={element.color}
          stroke="none"
          rx="4"
          className={cn(
            "cursor-pointer drop-shadow-md",
            selectedElement === element.id && "stroke-blue-500 stroke-2"
          )}
          onClick={() => selectSingleElement(element.id)}
          onDoubleClick={() => { if (canWrite) setEditingElement(element.id); }}
        />
        <foreignObject
          x={element.x}
          y={element.y}
          width={element.width}
          height={stickyHeight}
          style={{ pointerEvents: isEditing ? 'auto' : 'none' }}
        >
          <div className="h-full" style={{ padding: '12px 12px 12px 12px' }}>
            {isEditing ? (
              <textarea
                ref={(textarea) => focusTextareaAtEnd(textarea)}
                className="w-full h-full bg-transparent border-none outline-none resize-none text-gray-800 overflow-auto sticky-note-scrollbar"
                placeholder={st('sweep.weldflow.whiteboardView.addTextPlaceholder')}
                value={element.text}
                style={{
                  fontSize: element.fontSize,
                  lineHeight: `${lineHeight}px`,
                  scrollbarWidth: 'thin',
                  scrollbarColor: 'rgba(209, 213, 219, 0.4) transparent',
                  paddingRight: '2px'
                }}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => updateElementText(element.id, e.target.value)}
                onBlur={(e) => {
                  // Broadcast text change
                  void broadcastElementUpdate(element.id, { text: (e.target as HTMLTextAreaElement).value });
                  setEditingElement(null);
                  setTimeout(addToHistory, 100);
                }}
              />
            ) : (
              <div
                className="w-full h-full whitespace-pre-wrap break-words overflow-hidden"
                style={{ fontSize: element.fontSize, lineHeight: `${lineHeight}px` }}
              >
                {element.text}
              </div>
            )}
          </div>
        </foreignObject>

        {/* Resize handles */}
        {selectedElement === element.id && !isEditing && (
          <>
            <ResizeHandles
              left={element.x}
              top={element.y}
              right={element.x + element.width!}
              bottom={element.y + stickyHeight}
              tagged={false}
            />
            {/* Connection points for sticky notes */}
            {renderConnectionHandles(element)}
          </>
        )}
        {renderConnectionHover(element)}
      </g>
    );
  };

  const renderPathElement = (element: WhiteboardElement) => {
    const pathData = element.points?.map((p, i) =>
      i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`
    ).join(' ');
    return (
      <path
        d={pathData}
        fill="none"
        stroke={displayColor(element.strokeColor)}
        strokeWidth={element.strokeWidth || strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="cursor-pointer"
        onClick={() => setSelectedElement(element.id)}
      />
    );
  };

  const renderArrowElement = (element: WhiteboardElement) => {
    if (element.endX === undefined || element.endY === undefined) return null;

    const isArrowSelected = selectedElement === element.id;
    const curvePoints = isArrowSelected ? getArrowCurvePoints(element) : null;

    return (
      <g
        className="cursor-pointer"
        onClick={() => {
          // Only select if not already selected (clicking canvas will handle deselection)
          if (!isArrowSelected) {
            setSelectedElement(element.id);
          }
        }}
      >
        {renderArrowLine(element, isArrowSelected)}
        {/* Drag handles when selected */}
        {isArrowSelected && curvePoints && (
          <>
            {/* Start point handle */}
            <circle
              cx={curvePoints.startX}
              cy={curvePoints.startY}
              r={7}
              fill="white"
              stroke="#3b82f6"
              strokeWidth={2}
              className="cursor-move"
              style={{ pointerEvents: 'none' }}
            />
            {/* End point handle */}
            <circle
              cx={curvePoints.endX}
              cy={curvePoints.endY}
              r={7}
              fill="white"
              stroke="#3b82f6"
              strokeWidth={2}
              className="cursor-move"
              style={{ pointerEvents: 'none' }}
            />
            {/* Curve control handle (midpoint) */}
            <circle
              cx={curvePoints.curveMidX}
              cy={curvePoints.curveMidY}
              r={6}
              fill="#3b82f6"
              stroke="white"
              strokeWidth={2}
              className="cursor-move"
              style={{ pointerEvents: 'none' }}
            />
          </>
        )}
      </g>
    );
  };

  const renderElementContent = (element: WhiteboardElement) => {
    switch (element.type) {
      case 'rectangle':
        return renderRectangleElement(element);
      case 'circle':
        return renderCircleElement(element);
      case 'text':
        return renderTextElement(element);
      case 'sticky':
        return renderStickyElement(element);
      case 'path':
        return renderPathElement(element);
      case 'arrow':
        return renderArrowElement(element);
      default:
        return null;
    }
  };

  // Render element with eraser mask
  const renderElement = (element: WhiteboardElement) => {
    const maskId = `mask-${element.id}`;
    const needsMask = element.erasedPaths && element.erasedPaths.length > 0;

    // Render selection border for multi-selected elements using ref to get actual bounds
    const renderSelectionBorder = () => {
      if (!selectedElements.has(element.id)) return null;

      // For text elements, use a ref-based approach that's already handled in the text case
      if (element.type === 'text') return null;

      return (
        <rect
          className={`multi-selection-border-${element.id}`}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.5}
          rx={4}
          ry={4}
          pointerEvents="none"
          ref={(node) => {
            if (!node) return;
            // Find the actual element and get its bounding box
            const parent = node.parentElement;
            if (!parent) return;

            // Get the first visual element (rect, circle, path, etc.)
            const visualEl = parent.querySelector('rect:not([class*="selection"]):not([class*="multi-selection"]), circle:not([class*="selection"]), path, foreignObject');
            if (visualEl) {
              const bbox = (visualEl as SVGGraphicsElement).getBBox();
              node.setAttribute('x', String(bbox.x - 4));
              node.setAttribute('y', String(bbox.y - 4));
              node.setAttribute('width', String(bbox.width + 8));
              node.setAttribute('height', String(bbox.height + 8));
            }
          }}
        />
      );
    };

    if (needsMask) {
      return (
        <g key={element.id}>
          <defs>
            <mask id={maskId}>
              <rect x="-8000" y="-4500" width="16000" height="9000" fill="white" />
              {element.erasedPaths!.map((stroke, strokeIndex) => (
                <g key={strokeIndex}>
                  {/* Use path only for better performance */}
                  {stroke?.points && stroke.points.length > 0 && (
                    <path
                      d={stroke.points.map((p, i) =>
                        i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`
                      ).join(' ')}
                      stroke="black"
                      strokeWidth={stroke.size * 2} // Exact eraser size diameter
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                      opacity="1"
                    />
                  )}
                </g>
              ))}
            </mask>
          </defs>
          <g mask={`url(#${maskId})`}>
            {renderElementContent(element)}
          </g>
          {renderSelectionBorder()}
        </g>
      );
    }

    return (
      <g key={element.id}>
        {renderElementContent(element)}
        {renderSelectionBorder()}
      </g>
    );
  };

  const isCanvasInteracting = isPanning || isMiddleMouseDown || isTouchActive || isZooming;

  return (
    <div ref={containerRef} className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Toolbar */}
      {!isPresentMode && (
        <ProjectToolbar
          paddingTop="7.5px"
          paddingBottom="7.5px"
          paddingLeft="16px"
          paddingRight="16px"
          leftContent={
            <>
              {/* Tool buttons */}
          <ToolButton active={tool === 'select'} onSelect={() => setTool('select')} title={st('sweep.weldflow.whiteboardView.selectTool')} icon={MousePointer2} />
          <ToolButton active={tool === 'pan'} onSelect={() => setTool('pan')} title={st('sweep.weldflow.whiteboardView.panTool')} icon={Hand} />

          {canWrite && (
            <>
              <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

              <ToolButton active={tool === 'rectangle'} onSelect={() => setTool('rectangle')} title={st('sweep.weldflow.whiteboardView.rectangleTool')} icon={Square} />
              <ToolButton active={tool === 'circle'} onSelect={() => setTool('circle')} title={st('sweep.weldflow.whiteboardView.circleTool')} icon={Circle} />
              <ToolButton active={tool === 'arrow'} onSelect={() => setTool('arrow')} title={st('sweep.weldflow.whiteboardView.arrowTool')} icon={ArrowUpRight} />

              <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

              <ToolButton active={tool === 'text'} onSelect={() => setTool('text')} title={st('sweep.weldflow.whiteboardView.textTool')} icon={Type} />
              <ToolButton active={tool === 'sticky'} onSelect={() => setTool('sticky')} title={st('sweep.weldflow.whiteboardView.stickyNoteTool')} icon={StickyNote} />
              <ToolButton active={tool === 'pen'} onSelect={() => setTool('pen')} title={st('sweep.weldflow.whiteboardView.penTool')} icon={Pen} />
              <ToolButton active={tool === 'eraser'} onSelect={() => setTool('eraser')} title={st('sweep.weldflow.whiteboardView.eraserTool')} icon={Eraser} />

              <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

              {/* Color picker */}
          <div className="flex items-center gap-1">
            {colors.map(color => (
              <Button
                variant="ghost"
                key={color}
                className={cn(
                  "h-6 w-6 rounded border-2 transition-all duration-150",
                  selectedColor === color && "border-gray-500 dark:border-gray-300",
                  selectedColor !== color && hoveredColor === color && "border-gray-300 dark:border-gray-500",
                  selectedColor !== color && hoveredColor !== color && "border-transparent"
                )}
                style={{
                  backgroundColor: color
                }}
                onClick={() => {
                  setSelectedColor(color);
                  setStrokeColor(color);
                }}
                onMouseEnter={() => setHoveredColor(color)}
                onMouseLeave={() => setHoveredColor(null)}
              />
            ))}
          </div>
          
          {/* Tool-specific options */}
          {STROKE_WIDTH_TOOLS.has(tool) && (
            <>
              <div className="w-px h-6 bg-gray-300 dark:bg-accent mx-1" />
              <div className="flex items-center gap-2 px-2 py-1 border border-gray-200 dark:border-border rounded-md bg-white dark:bg-secondary">
                <span className="text-xs text-gray-600 dark:text-muted-foreground">{st('sweep.weldflow.whiteboardView.stroke')}:</span>
                <Slider
                  value={[strokeWidth]}
                  onValueChange={(value) => setStrokeWidth(value[0])}
                  min={1}
                  max={10}
                  step={1}
                  className="w-24"
                />
                <span className="text-xs text-gray-600 dark:text-muted-foreground w-8">{strokeWidth}px</span>
              </div>
            </>
          )}
          
          {tool === 'arrow' && (
            <>
              <div className="w-px h-6 bg-gray-300 dark:bg-accent mx-1" />
              <div className="flex items-center gap-1">
                <ToolButton active={arrowType === 'line'} onSelect={() => setArrowType('line')} title={st('sweep.weldflow.whiteboardView.line')} icon={Minus} buttonClassName="h-7 w-7 p-0" iconClassName="h-3.5 w-3.5" />
                <ToolButton active={arrowType === 'arrow'} onSelect={() => setArrowType('arrow')} title={st('sweep.weldflow.whiteboardView.arrow')} icon={ArrowRight} buttonClassName="h-7 w-7 p-0" iconClassName="h-3.5 w-3.5" />
                <ToolButton active={arrowType === 'elbow'} onSelect={() => setArrowType('elbow')} title={st('sweep.weldflow.whiteboardView.elbowArrow')} icon={CornerDownRight} buttonClassName="h-7 w-7 p-0" iconClassName="h-3.5 w-3.5" />
              </div>
            </>
          )}
          
          
          {FILL_MODE_TOOLS.has(tool) && (
            <div className="flex items-center gap-2 ml-2">
              <ToggleGroup type="single" value={fillMode} onValueChange={(value) => value && setFillMode(value as 'fill' | 'both' | 'stroke')}>
                <ToggleGroupItem value="fill" size="sm" className="h-6 px-2">
                  <span className="text-xs">{st('sweep.weldflow.whiteboardView.fill')}</span>
                </ToggleGroupItem>
                <ToggleGroupItem value="stroke" size="sm" className="h-6 px-2">
                  <span className="text-xs">{st('sweep.weldflow.whiteboardView.stroke')}</span>
                </ToggleGroupItem>
                <ToggleGroupItem value="both" size="sm" className="h-6 px-2">
                  <span className="text-xs">{st('sweep.weldflow.whiteboardView.both')}</span>
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          )}
          
          {FONT_SIZE_TOOLS.has(tool) && (
            <>
              <div className="w-px h-6 bg-gray-300 dark:bg-accent mx-1" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600 dark:text-muted-foreground">{st('sweep.weldflow.whiteboardView.fontLabel')}</span>
                <Select value={fontSize.toString()} onValueChange={(value) => setFontSize(Number.parseInt(value))}>
                  <SelectTrigger size="sm" className="h-8 w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="12">12px</SelectItem>
                    <SelectItem value="14">14px</SelectItem>
                    <SelectItem value="16">16px</SelectItem>
                    <SelectItem value="18">18px</SelectItem>
                    <SelectItem value="20">20px</SelectItem>
                    <SelectItem value="24">24px</SelectItem>
                    <SelectItem value="28">28px</SelectItem>
                    <SelectItem value="32">32px</SelectItem>
                    <SelectItem value="36">36px</SelectItem>
                    <SelectItem value="48">48px</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          
          {tool === 'eraser' && (
            <>
              <div className="w-px h-6 bg-gray-300 dark:bg-accent mx-1" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600 dark:text-muted-foreground">{st('sweep.weldflow.whiteboardView.sizeLabel')}</span>
                <Slider
                  value={[eraserSize]}
                  onValueChange={(value) => setEraserSize(value[0])}
                  min={5}
                  max={100}
                  step={5}
                  className="w-24"
                />
                <span className="text-xs text-gray-600 dark:text-muted-foreground w-8">{eraserSize}px</span>
              </div>
            </>
          )}
            </>
          )}
          </>
          }
          rightContent={
            <>
              {/* Undo/Redo buttons */}
              {canWrite && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={undo}
                    disabled={historyIndex <= 0}
                    title={st('sweep.weldflow.whiteboardView.undoShortcut')}
                  >
                    <Undo2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={redo}
                    disabled={historyIndex >= history.length - 1}
                    title={st('sweep.weldflow.whiteboardView.redoShortcut')}
                  >
                    <Redo2 className="h-4 w-4" />
                  </Button>

                  <div className="w-px h-6 bg-gray-100 dark:bg-secondary/50" />
                </>
              )}

          {/* Zoom controls */}
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                if (zoomIndex > 0) {
                  const newIndex = zoomIndex - 1;
                  const newScale = zoomLevels[newIndex];
                  const scaleRatio = newScale / zoom;

                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (rect) {
                    const centerX = rect.width / 2;
                    const centerY = rect.height / 2;
                    setPanPosition(prev => {
                      const newX = centerX - (centerX - prev.x) * scaleRatio;
                      const newY = centerY - (centerY - prev.y) * scaleRatio;
                      return clampPanPosition(newX, newY, newScale);
                    });
                  }

                  zoomRef.current = newScale;
                  setZoom(newScale);
                  setZoomIndex(newIndex);
                  setIsZooming(true);
                  if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
                  zoomTimeoutRef.current = setTimeout(() => setIsZooming(false), 200);
                }
              }}
              disabled={zoomIndex <= 0}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                if (zoomIndex < zoomLevels.length - 1) {
                  const newIndex = zoomIndex + 1;
                  const newScale = zoomLevels[newIndex];
                  const scaleRatio = newScale / zoom;

                  const rect = canvasRef.current?.getBoundingClientRect();
                  if (rect) {
                    const centerX = rect.width / 2;
                    const centerY = rect.height / 2;
                    setPanPosition(prev => {
                      const newX = centerX - (centerX - prev.x) * scaleRatio;
                      const newY = centerY - (centerY - prev.y) * scaleRatio;
                      return clampPanPosition(newX, newY, newScale);
                    });
                  }

                  zoomRef.current = newScale;
                  setZoom(newScale);
                  setZoomIndex(newIndex);
                  setIsZooming(true);
                  if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
                  zoomTimeoutRef.current = setTimeout(() => setIsZooming(false), 200);
                }
              }}
              disabled={zoomIndex >= zoomLevels.length - 1}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {/* Real-time collaboration presence indicator */}
          <PresenceIndicator
            presence={remotePresence}
          />

          <div className="w-px h-5 bg-border mx-1" />

          <Button
            variant="ghost"
            size="icon"
            title={st('sweep.weldflow.whiteboardView.present')}
            aria-label={st('sweep.weldflow.whiteboardView.present')}
            className={cn(
              "h-8 w-8",
              isPresentMode && "text-foreground"
            )}
            onClick={togglePresentMode}
          >
            <Presentation className="h-4 w-4" />
          </Button>
          </>
          }
        />
      )}

      {/* Exit present mode button */}
      {isPresentMode && (
        <div className="absolute top-4 right-4 z-20">
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-3 shadow-lg"
            onClick={togglePresentMode}
          >
            {st('sweep.weldflow.whiteboardView.exitPresent')}
          </Button>
        </div>
      )}

      {/* Floating toolbar for selected text element */}
      {canWrite && selectedElement && !isPresentMode && !isPanning && (() => {
        const element = elements.find(el => el.id === selectedElement);
        if (element?.type !== 'text') return null;

        // Use cached canvas rect position
        const { left: canvasLeft, top: canvasTop } = canvasRectRef.current;

        // Use actual bounding box if available, otherwise estimate
        let centerX: number;
        let topY: number;

        if (textBoundingBox) {
          centerX = textBoundingBox.x + textBoundingBox.width / 2;
          topY = textBoundingBox.y;
        } else {
          // Fallback estimation
          const lines = (element.text || '').split('\n');
          const longestLine = lines.reduce((a, b) => a.length > b.length ? a : b, '');
          const textWidth = longestLine.length * (element.fontSize || 16) * 0.6;
          centerX = element.x + textWidth / 2;
          topY = element.y - (element.fontSize || 16);
        }

        // Convert canvas coordinates to viewport coordinates, then clamp so the
        // floating toolbar never falls off the viewport edges.
        const rawScreenX = canvasLeft + centerX * zoom + panPosition.x;
        const rawScreenY = canvasTop + topY * zoom + panPosition.y;
        const TOOLBAR_HALF_WIDTH = 160;
        const TOOLBAR_OFFSET_TOP = 70;
        const VIEWPORT_PADDING = 8;
        const screenX = Math.max(
          TOOLBAR_HALF_WIDTH + VIEWPORT_PADDING,
          Math.min(window.innerWidth - TOOLBAR_HALF_WIDTH - VIEWPORT_PADDING, rawScreenX)
        );
        const screenY = Math.max(TOOLBAR_OFFSET_TOP + VIEWPORT_PADDING, rawScreenY);

        return (
          <div
            className="fixed z-50 flex items-center gap-0.5 px-2 py-1.5 bg-white dark:bg-secondary rounded-lg shadow border border-gray-200 dark:border-border"
            style={{
              left: screenX,
              top: screenY - TOOLBAR_OFFSET_TOP,
              transform: 'translateX(-50%)',
              pointerEvents: (isDraggingElement || isResizing || isDrawingConnection) ? 'none' : 'auto',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Font size selector */}
            <Select
              value={(element.fontSize || 16).toString()}
              onValueChange={(value) => {
                setElements(elements.map(el =>
                  el.id === selectedElement ? { ...el, fontSize: Number.parseInt(value) } : el
                ));
                setTimeout(addToHistory, 100);
              }}
            >
              <SelectTrigger size="sm" className="h-8 w-16 border-none shadow-none text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72, 96].map(size => (
                  <SelectItem key={size} value={size.toString()}>{size}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

            {/* Bold */}
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 w-8 p-0",
                element.fontWeight === 'bold' && "bg-gray-100 dark:bg-accent"
              )}
              onClick={() => {
                setElements(elements.map(el =>
                  el.id === selectedElement
                    ? { ...el, fontWeight: el.fontWeight === 'bold' ? 'normal' : 'bold' }
                    : el
                ));
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.actionConfig.bold')}
            >
              <Bold className="h-4 w-4" />
            </Button>

            {/* Italic */}
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 w-8 p-0",
                element.fontStyle === 'italic' && "bg-gray-100 dark:bg-accent"
              )}
              onClick={() => {
                setElements(elements.map(el =>
                  el.id === selectedElement
                    ? { ...el, fontStyle: el.fontStyle === 'italic' ? 'normal' : 'italic' }
                    : el
                ));
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.actionConfig.italic')}
            >
              <Italic className="h-4 w-4" />
            </Button>

            {/* Underline */}
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 w-8 p-0",
                element.textDecoration === 'underline' && "bg-gray-100 dark:bg-accent"
              )}
              onClick={() => {
                setElements(elements.map(el =>
                  el.id === selectedElement
                    ? { ...el, textDecoration: el.textDecoration === 'underline' ? 'none' : 'underline' }
                    : el
                ));
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.actionConfig.underline')}
            >
              <Underline className="h-4 w-4" />
            </Button>

            <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

            {/* Text alignment */}
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 w-8 p-0",
                (!element.textAlign || element.textAlign === 'left') && "bg-gray-100 dark:bg-accent"
              )}
              onClick={() => {
                setElements(elements.map(el =>
                  el.id === selectedElement ? { ...el, textAlign: 'left' } : el
                ));
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.whiteboardView.alignLeft')}
            >
              <AlignLeft className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 w-8 p-0",
                element.textAlign === 'center' && "bg-gray-100 dark:bg-accent"
              )}
              onClick={() => {
                setElements(elements.map(el =>
                  el.id === selectedElement ? { ...el, textAlign: 'center' } : el
                ));
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.whiteboardView.alignCenter')}
            >
              <AlignCenter className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 w-8 p-0",
                element.textAlign === 'right' && "bg-gray-100 dark:bg-accent"
              )}
              onClick={() => {
                setElements(elements.map(el =>
                  el.id === selectedElement ? { ...el, textAlign: 'right' } : el
                ));
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.whiteboardView.alignRight')}
            >
              <AlignRight className="h-4 w-4" />
            </Button>

            <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

            {/* Link */}
            <DropdownMenu open={showLinkDialog} onOpenChange={(open) => {
              setShowLinkDialog(open);
              if (open) {
                setLinkInputValue(element.link || '');
              }
            }}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-8 w-8 p-0",
                    element.link && "bg-gray-100 dark:bg-accent"
                  )}
                  title={st('sweep.weldflow.whiteboardView.addLink')}
                >
                  <Link className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="p-3 w-72" align="start">
                <div className="space-y-3">
                  <div className="text-sm font-medium">{st('sweep.weldflow.whiteboardView.insertLink')}</div>
                  <input
                    type="url"
                    placeholder={st('sweep.weldflow.whiteboardView.urlPlaceholder')}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-secondary outline-none focus:ring-2 focus:ring-blue-500"
                    value={linkInputValue}
                    onChange={(e) => setLinkInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setElements(elements.map(el =>
                          el.id === selectedElement ? { ...el, link: linkInputValue || undefined } : el
                        ));
                        setTimeout(addToHistory, 100);
                        setShowLinkDialog(false);
                      }
                    }}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setShowLinkDialog(false)}
                    >
                      {st('sweep.weldflow.cancel')}
                    </Button>
                    {element.link && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-500 hover:text-red-600"
                        onClick={() => {
                          setElements(elements.map(el =>
                            el.id === selectedElement ? { ...el, link: undefined } : el
                          ));
                          setTimeout(addToHistory, 100);
                          setShowLinkDialog(false);
                        }}
                      >
                        {st('sweep.weldflow.whiteboardView.remove')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => {
                        setElements(elements.map(el =>
                          el.id === selectedElement ? { ...el, link: linkInputValue || undefined } : el
                        ));
                        setTimeout(addToHistory, 100);
                        setShowLinkDialog(false);
                      }}
                    >
                      {st('sweep.weldflow.whiteboardView.apply')}
                    </Button>
                  </div>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

            {/* Text color */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <div
                    className="w-4 h-4 rounded border border-gray-300"
                    style={{ backgroundColor: element.color || '#000000' }}
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <div className="grid grid-cols-5 gap-1 p-2">
                  {['#000000', '#374151', '#DC2626', '#EA580C', '#CA8A04', '#16A34A', '#0891B2', '#2563EB', '#7C3AED', '#DB2777'].map(color => (
                    <Button
                      variant="ghost"
                      key={color}
                      className={cn(
                        "w-6 h-6 rounded border-2 transition-all",
                        element.color === color ? "border-blue-500" : "border-transparent hover:border-gray-400"
                      )}
                      style={{ backgroundColor: color }}
                      onClick={() => {
                        setElements(elements.map(el =>
                          el.id === selectedElement ? { ...el, color } : el
                        ));
                        setTimeout(addToHistory, 100);
                      }}
                    />
                  ))}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

            {/* Duplicate */}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => {
                const newElement = {
                  ...element,
                  id: Date.now().toString(),
                  x: element.x + 20,
                  y: element.y + 20,
                };
                setElements([...elements, newElement]);
                setSelectedElement(newElement.id);
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.whiteboardView.duplicate')}
            >
              <Copy className="h-4 w-4" />
            </Button>

            {/* Delete */}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-50"
              onClick={() => {
                setElements(elements.filter(el => el.id !== selectedElement));
                setSelectedElement(null);
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      })()}

      {/* Floating toolbar for selected shape/arrow/path/sticky elements */}
      {canWrite && selectedElement && !isPresentMode && !isPanning && (() => {
        const element = elements.find(el => el.id === selectedElement);
        if (!element || element.type === 'text') return null;

        // Use cached canvas rect position
        const { left: canvasLeft, top: canvasTop } = canvasRectRef.current;

        // Calculate element bounds based on type
        let centerX: number;
        let topY: number;

        if (element.type === 'rectangle' || element.type === 'sticky') {
          centerX = element.x + (element.width || 0) / 2;
          topY = element.y;
        } else if (element.type === 'circle') {
          centerX = element.x;
          topY = element.y - (element.radiusY ?? element.radius ?? 50);
        } else if (element.type === 'arrow') {
          centerX = (element.x + (element.endX || element.x)) / 2;
          topY = Math.min(element.y, element.endY || element.y);
        } else if (element.type === 'path' && element.points && element.points.length > 0) {
          const minX = Math.min(...element.points.map(p => p.x));
          const maxX = Math.max(...element.points.map(p => p.x));
          const minY = Math.min(...element.points.map(p => p.y));
          centerX = (minX + maxX) / 2;
          topY = minY;
        } else {
          return null;
        }

        // Convert canvas coordinates to viewport coordinates, then clamp so the
        // floating toolbar never falls off the viewport edges.
        const rawScreenX = canvasLeft + centerX * zoom + panPosition.x;
        const rawScreenY = canvasTop + topY * zoom + panPosition.y;
        const TOOLBAR_HALF_WIDTH = 160;
        const TOOLBAR_OFFSET_TOP = 70;
        const VIEWPORT_PADDING = 8;
        const screenX = Math.max(
          TOOLBAR_HALF_WIDTH + VIEWPORT_PADDING,
          Math.min(window.innerWidth - TOOLBAR_HALF_WIDTH - VIEWPORT_PADDING, rawScreenX)
        );
        const screenY = Math.max(TOOLBAR_OFFSET_TOP + VIEWPORT_PADDING, rawScreenY);

        return (
          <div
            className="fixed z-50 flex items-center gap-0.5 px-2 py-1.5 bg-white dark:bg-secondary rounded-lg shadow border border-gray-200 dark:border-border"
            style={{
              left: screenX,
              top: screenY - TOOLBAR_OFFSET_TOP,
              transform: 'translateX(-50%)',
              pointerEvents: (isDraggingElement || isResizing || isDrawingConnection) ? 'none' : 'auto',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Stroke color */}
            {(element.type === 'rectangle' || element.type === 'circle' || element.type === 'arrow' || element.type === 'path') && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title={st('sweep.weldflow.whiteboardView.strokeColor')}>
                      <div
                        className="w-5 h-5 rounded border border-gray-300"
                        style={{ backgroundColor: element.strokeColor || '#000000' }}
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <div className="grid grid-cols-5 gap-1 p-2">
                      {['#000000', '#374151', '#DC2626', '#EA580C', '#CA8A04', '#16A34A', '#0891B2', '#2563EB', '#7C3AED', '#DB2777', 'transparent'].map(color => (
                        <Button
                          variant="ghost"
                          key={color}
                          className={cn(
                            "w-6 h-6 rounded border-2 transition-all",
                            color === 'transparent' ? "bg-white bg-[linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%,#ccc),linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%,#ccc)] bg-[length:8px_8px] bg-[position:0_0,4px_4px]" : "",
                            element.strokeColor === color ? "border-blue-500" : "border-transparent hover:border-gray-400"
                          )}
                          style={{ backgroundColor: color === 'transparent' ? undefined : color }}
                          onClick={() => {
                            setElements(elements.map(el =>
                              el.id === selectedElement ? { ...el, strokeColor: color } : el
                            ));
                            setTimeout(addToHistory, 100);
                          }}
                        />
                      ))}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />
              </>
            )}

            {/* Fill color for shapes */}
            {(element.type === 'rectangle' || element.type === 'circle' || element.type === 'sticky') && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title={st('sweep.weldflow.whiteboardView.fillColor')}>
                      <div
                        className={cn(
                          "w-5 h-5 rounded border border-gray-300",
                          (!element.color || element.color === 'transparent') && "bg-white bg-[linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%,#ccc),linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%,#ccc)] bg-[length:8px_8px] bg-[position:0_0,4px_4px]"
                        )}
                        style={{ backgroundColor: element.color && element.color !== 'transparent' ? element.color : undefined }}
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <div className="grid grid-cols-5 gap-1 p-2">
                      {['transparent', '#FFFFFF', '#F3F4F6', '#FEE2E2', '#FEF3C7', '#D1FAE5', '#CFFAFE', '#DBEAFE', '#EDE9FE', '#FCE7F3',
                        '#000000', '#374151', '#DC2626', '#EA580C', '#CA8A04', '#16A34A', '#0891B2', '#2563EB', '#7C3AED', '#DB2777'].map(color => (
                        <Button
                          variant="ghost"
                          key={color}
                          className={cn(
                            "w-6 h-6 rounded border-2 transition-all",
                            color === 'transparent' ? "bg-white bg-[linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%,#ccc),linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%,#ccc)] bg-[length:8px_8px] bg-[position:0_0,4px_4px]" : "",
                            element.color === color ? "border-blue-500" : "border-transparent hover:border-gray-400"
                          )}
                          style={{ backgroundColor: color === 'transparent' ? undefined : color }}
                          onClick={() => {
                            setElements(elements.map(el =>
                              el.id === selectedElement ? { ...el, color } : el
                            ));
                            setTimeout(addToHistory, 100);
                          }}
                        />
                      ))}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />
              </>
            )}

            {/* Stroke width */}
            {(element.type === 'rectangle' || element.type === 'circle' || element.type === 'arrow' || element.type === 'path') && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 px-2 gap-1.5" title={st('sweep.weldflow.whiteboardView.strokeWidth')}>
                      <div className="flex items-center gap-1">
                        <div className="w-4 h-0.5 bg-current rounded" style={{ height: Math.min(4, element.strokeWidth || 2) }} />
                        <span className="text-xs">{element.strokeWidth || 2}px</span>
                      </div>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-48 p-3">
                    <div className="space-y-2">
                      <div className="text-xs text-gray-500">{st('sweep.weldflow.whiteboardView.strokeWidth')}</div>
                      <Slider
                        value={[element.strokeWidth || 2]}
                        min={1}
                        max={20}
                        step={1}
                        onValueChange={([value]) => {
                          setElements(elements.map(el =>
                            el.id === selectedElement ? { ...el, strokeWidth: value } : el
                          ));
                        }}
                        onValueCommit={() => setTimeout(addToHistory, 100)}
                      />
                      <div className="flex justify-between text-xs text-gray-400">
                        <span>1px</span>
                        <span>20px</span>
                      </div>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />
              </>
            )}

            {/* Arrow type selector */}
            {element.type === 'arrow' && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 px-2 gap-1" title={st('sweep.weldflow.whiteboardView.arrowType')}>
                      {element.arrowType === 'line' && <Minus className="h-4 w-4" />}
                      {element.arrowType === 'elbow' && <CornerDownRight className="h-4 w-4" />}
                      {(!element.arrowType || element.arrowType === 'arrow') && <ArrowRight className="h-4 w-4" />}
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={() => {
                      setElements(elements.map(el =>
                        el.id === selectedElement ? { ...el, arrowType: 'line' } : el
                      ));
                      setTimeout(addToHistory, 100);
                    }}>
                      <Minus className="h-4 w-4 mr-2" /> Line
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      setElements(elements.map(el =>
                        el.id === selectedElement ? { ...el, arrowType: 'arrow' } : el
                      ));
                      setTimeout(addToHistory, 100);
                    }}>
                      <ArrowRight className="h-4 w-4 mr-2" /> Arrow
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      setElements(elements.map(el =>
                        el.id === selectedElement ? { ...el, arrowType: 'elbow' } : el
                      ));
                      setTimeout(addToHistory, 100);
                    }}>
                      <CornerDownRight className="h-4 w-4 mr-2" /> Elbow
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />
              </>
            )}

            {/* Duplicate */}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => {
                const newElement = {
                  ...element,
                  id: Date.now().toString(),
                  x: element.x + 20,
                  y: element.y + 20,
                  ...(element.type === 'arrow' && element.endX && element.endY ? {
                    endX: element.endX + 20,
                    endY: element.endY + 20,
                  } : {}),
                  ...(element.type === 'path' && element.points ? {
                    points: element.points.map(p => ({ x: p.x + 20, y: p.y + 20 })),
                  } : {}),
                };
                setElements([...elements, newElement]);
                setSelectedElement(newElement.id);
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.whiteboardView.duplicate')}
            >
              <Copy className="h-4 w-4" />
            </Button>

            {/* Delete */}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-50"
              onClick={() => {
                setElements(elements.filter(el => el.id !== selectedElement));
                setSelectedElement(null);
                setTimeout(addToHistory, 100);
              }}
              title={st('sweep.weldflow.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      })()}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-[100] animate-in fade-in-0 zoom-in-95"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
        >
          <div className="bg-popover text-popover-foreground min-w-[180px] overflow-hidden rounded-md border p-1 shadow-md">
            <Button
              variant="ghost"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              onClick={bringToFront}
            >
              <BringToFront className="mr-2 h-4 w-4" />
              {st('sweep.weldflow.whiteboardView.bringToFront')}
              <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘]</span>
            </Button>
            <Button
              variant="ghost"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              onClick={bringForward}
            >
              <ArrowUp className="mr-2 h-4 w-4" />
              {st('sweep.weldflow.whiteboardView.bringForward')}
            </Button>
            <Button
              variant="ghost"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              onClick={sendBackward}
            >
              <ArrowDown className="mr-2 h-4 w-4" />
              {st('sweep.weldflow.whiteboardView.sendBackward')}
            </Button>
            <Button
              variant="ghost"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              onClick={sendToBack}
            >
              <SendToBack className="mr-2 h-4 w-4" />
              {st('sweep.weldflow.whiteboardView.sendToBack')}
              <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘[</span>
            </Button>
            <div className="-mx-1 my-1 h-px bg-border" />
            <Button
              variant="ghost"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              onClick={copyElement}
            >
              <Clipboard className="mr-2 h-4 w-4" />
              {st('sweep.weldflow.whiteboardView.copy')}
              <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘C</span>
            </Button>
            <Button
              variant="ghost"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
              onClick={duplicateElement}
            >
              <Copy className="mr-2 h-4 w-4" />
              {st('sweep.weldflow.whiteboardView.duplicate')}
              <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘D</span>
            </Button>
            {clipboard.length > 0 && (
              <Button
                variant="ghost"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                onClick={pasteElement}
              >
                <ClipboardPaste className="mr-2 h-4 w-4" />
                {st('sweep.weldflow.whiteboardView.paste')}
                <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘V</span>
              </Button>
            )}
            <div className="-mx-1 my-1 h-px bg-border" />
            <Button
              variant="ghost"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-destructive hover:bg-destructive/10 focus:bg-destructive/10"
              onClick={deleteElement}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {st('sweep.weldflow.delete')}
              <span className="ml-auto text-xs tracking-widest">⌫</span>
            </Button>
          </div>
        </div>
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="relative flex-1 overflow-hidden bg-[#f7f7f7] dark:bg-[#17181a] cursor-crosshair select-none"
        style={{
          cursor: getCanvasCursor(isMiddleMouseDown || isPanning, tool),
          touchAction: 'none', // Prevent default touch behaviors for canvas manipulation
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          style={getCanvasSvgStyle(isCanvasInteracting, panPosition, zoom)}
        >
          {/* Grid pattern definitions */}
          <defs>
            {/* Line grid for normal/high zoom */}
            <pattern id="grid-lines" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#e5e5e5" strokeWidth="0.5" className="stroke-[#e5e5e5] dark:stroke-[#2a2a2e]" />
            </pattern>
            {/* Larger line grid for zoomed out view */}
            <pattern id="grid-lines-large" width="192" height="192" patternUnits="userSpaceOnUse">
              <path d="M 192 0 L 0 0 0 192" fill="none" stroke="#e5e5e5" strokeWidth="1" className="stroke-[#e5e5e5] dark:stroke-[#2a2a2e]" />
            </pattern>
          </defs>
          {/* Background for canvas area */}
          <rect width="16000" height="9000" x="-8000" y="-4500" className="fill-white dark:fill-[#17181a]" />
          {/* Grid lines - use larger pattern at low zoom for performance */}
          {zoom > 0.5 && (
            <rect width="16000" height="9000" x="-8000" y="-4500" fill="url(#grid-lines)" />
          )}
          {zoom <= 0.5 && (
            <rect width="16000" height="9000" x="-8000" y="-4500" fill="url(#grid-lines-large)" />
          )}
          
          {/* Render elements */}
          {elements.map((element) => renderElement(element))}
          
          {/* Selection box */}
          {isSelecting && selectionBox && (
            <rect
              x={Math.min(selectionBox.startX, selectionBox.endX)}
              y={Math.min(selectionBox.startY, selectionBox.endY)}
              width={Math.abs(selectionBox.endX - selectionBox.startX)}
              height={Math.abs(selectionBox.endY - selectionBox.startY)}
              fill="rgba(59, 130, 246, 0.1)"
              stroke="rgb(59, 130, 246)"
              strokeWidth="1"
              strokeDasharray="4,2"
              pointerEvents="none"
            />
          )}
          
          {/* Current drawing preview */}
          {isDrawing && tool === 'rectangle' && currentPoint.x !== 0 && currentPoint.y !== 0 && (() => {
            let width = Math.abs(currentPoint.x - startPoint.x);
            let height = Math.abs(currentPoint.y - startPoint.y);
            let x = Math.min(startPoint.x, currentPoint.x);
            let y = Math.min(startPoint.y, currentPoint.y);

            // If shift is held, make it a square
            if (currentPoint.shiftKey) {
              const size = Math.max(width, height);
              width = size;
              height = size;

              // Adjust position based on drag direction
              if (currentPoint.x < startPoint.x) {
                x = startPoint.x - size;
              }
              if (currentPoint.y < startPoint.y) {
                y = startPoint.y - size;
              }
            }

            return (
              <rect
                x={x}
                y={y}
                width={width}
                height={height}
                fill={fillMode === 'stroke' ? 'none' : displayColor(selectedColor)}
                fillOpacity={fillMode === 'stroke' ? 0 : 0.5}
                stroke={fillMode === 'fill' ? 'none' : displayColor(strokeColor)}
                strokeWidth={strokeWidth}
                strokeDasharray="5,5"
              />
            );
          })()}

          {/* Circle/Ellipse preview */}
          {isDrawing && tool === 'circle' && currentPoint.x !== 0 && currentPoint.y !== 0 && (() => {
            let width = Math.abs(currentPoint.x - startPoint.x);
            let height = Math.abs(currentPoint.y - startPoint.y);

            // If shift is held, make it a perfect circle
            if (currentPoint.shiftKey) {
              const size = Math.max(width, height);
              width = size;
              height = size;
            }

            const radiusX = width / 2;
            const radiusY = height / 2;

            let centerX, centerY;
            if (currentPoint.shiftKey) {
              centerX = currentPoint.x < startPoint.x ? startPoint.x - width / 2 : startPoint.x + width / 2;
              centerY = currentPoint.y < startPoint.y ? startPoint.y - height / 2 : startPoint.y + height / 2;
            } else {
              centerX = Math.min(startPoint.x, currentPoint.x) + radiusX;
              centerY = Math.min(startPoint.y, currentPoint.y) + radiusY;
            }

            return (
              <ellipse
                cx={centerX}
                cy={centerY}
                rx={radiusX}
                ry={radiusY}
                fill={fillMode === 'stroke' ? 'none' : displayColor(selectedColor)}
                fillOpacity={fillMode === 'stroke' ? 0 : 0.5}
                stroke={fillMode === 'fill' ? 'none' : displayColor(strokeColor)}
                strokeWidth={strokeWidth}
                strokeDasharray="5,5"
              />
            );
          })()}
          
          {/* Arrow preview */}
          {isDrawing && tool === 'arrow' && currentPoint.x !== 0 && currentPoint.y !== 0 && (
            <g opacity="0.6">
              {arrowType === 'elbow' ? (
                <>
                  {/* Elbow arrow preview */}
                  <path
                    d={`M ${startPoint.x} ${startPoint.y} L ${startPoint.x + (currentPoint.x - startPoint.x) / 2} ${startPoint.y} L ${startPoint.x + (currentPoint.x - startPoint.x) / 2} ${currentPoint.y} L ${currentPoint.x} ${currentPoint.y}`}
                    fill="none"
                    stroke={displayColor(strokeColor)}
                    strokeWidth={strokeWidth}
                    strokeDasharray="5,5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {renderArrowHead(
                    startPoint.x + (currentPoint.x - startPoint.x) / 2,
                    currentPoint.y,
                    currentPoint.x,
                    currentPoint.y,
                    displayColor(strokeColor),
                    strokeWidth
                  )}
                </>
              ) : (
                <>
                  {/* Straight line/arrow preview */}
                  <line
                    x1={startPoint.x}
                    y1={startPoint.y}
                    x2={currentPoint.x}
                    y2={currentPoint.y}
                    stroke={displayColor(strokeColor)}
                    strokeWidth={strokeWidth}
                    strokeDasharray="5,5"
                  />
                  {arrowType === 'arrow' && renderArrowHead(
                    startPoint.x,
                    startPoint.y,
                    currentPoint.x,
                    currentPoint.y,
                    displayColor(strokeColor),
                    strokeWidth
                  )}
                </>
              )}
            </g>
          )}

          {/* Connection line preview */}
          {isDrawingConnection && connectionStart && connectionEndPoint && (
            (() => {
              const startX = connectionStart.x;
              const startY = connectionStart.y;
              const endX = connectionEndPoint.x;
              const endY = connectionEndPoint.y;
              const dx = endX - startX;
              const dy = endY - startY;
              const distance = Math.hypot(dx, dy);
              const curveOffset = Math.min(distance * 0.5, 150);

              // Control point 1 based on start connection point
              let cp1x: number, cp1y: number;
              switch (connectionStart.point) {
                case 'top':
                  cp1x = startX;
                  cp1y = startY - curveOffset;
                  break;
                case 'bottom':
                  cp1x = startX;
                  cp1y = startY + curveOffset;
                  break;
                case 'left':
                  cp1x = startX - curveOffset;
                  cp1y = startY;
                  break;
                case 'right':
                  cp1x = startX + curveOffset;
                  cp1y = startY;
                  break;
                default:
                  cp1x = startX;
                  cp1y = startY;
              }

              // Control point 2 based on snapped end point or default
              let cp2x: number, cp2y: number;
              if (snappedConnectionPoint) {
                switch (snappedConnectionPoint) {
                  case 'top':
                    cp2x = endX;
                    cp2y = endY - curveOffset;
                    break;
                  case 'bottom':
                    cp2x = endX;
                    cp2y = endY + curveOffset;
                    break;
                  case 'left':
                    cp2x = endX - curveOffset;
                    cp2y = endY;
                    break;
                  case 'right':
                    cp2x = endX + curveOffset;
                    cp2y = endY;
                    break;
                  default:
                    cp2x = endX;
                    cp2y = endY;
                }
              } else {
                // Free endpoint: curve towards the cursor naturally
                cp2x = endX;
                cp2y = endY;
              }

              const pathData = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
              const tangentX = endX - cp2x;
              const tangentY = endY - cp2y;

              return (
                <g>
                  <path
                    d={pathData}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    strokeDasharray="5,5"
                  />
                  {renderArrowHeadWithTangent(endX, endY, tangentX, tangentY, "#3b82f6", 2)}
                </g>
              );
            })()
          )}

          {/* Current path being drawn */}
          {isDrawing && tool === 'pen' && currentPath.length > 0 && (
            <path
              d={currentPath.map((p, i) =>
                i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`
              ).join(' ')}
              fill="none"
              stroke={displayColor(strokeColor)}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          
          {/* Eraser preview circle */}
          {tool === 'eraser' && currentPoint.x !== 0 && currentPoint.y !== 0 && (
            <EraserPreview x={currentPoint.x} y={currentPoint.y} size={eraserSize} isErasing={isErasing} />
          )}
        </svg>

        {/* Remote cursors overlay for real-time collaboration */}
        {isConnected && remoteCursors.length > 0 && (
          <RemoteCursors
            cursors={remoteCursors}
            viewTransform={{ x: panPosition.x, y: panPosition.y, scale: zoom }}
          />
        )}
      </div>

      {/* Minimap - disabled during scroll panning for performance, only show during drag pan */}
      {isMiddleMouseDown && elements.length < 100 && (
        <div className="absolute bottom-4 right-4 bg-white dark:bg-secondary border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg p-2 pointer-events-none z-50">
          <div className="relative w-48 h-32 bg-gray-50 dark:bg-background rounded overflow-hidden">
            <svg 
              width="192" 
              height="128" 
              viewBox={`${getMinimapViewBox()}`}
              className="absolute inset-0"
            >
              {/* Render minimap elements */}
              {elements.map(el => (
                <g key={el.id} opacity="0.6">
                  {el.type === 'rectangle' && (
                    <rect
                      x={el.x}
                      y={el.y}
                      width={el.width || 0}
                      height={el.height || 0}
                      fill={displayColor(el.color)}
                      stroke={el.strokeColor || 'none'}
                      strokeWidth={(el.strokeWidth || 1) * 0.5}
                    />
                  )}
                  {el.type === 'circle' && (
                    <ellipse
                      cx={el.x}
                      cy={el.y}
                      rx={el.radiusX ?? el.radius ?? 50}
                      ry={el.radiusY ?? el.radius ?? 50}
                      fill={displayColor(el.color)}
                      stroke={el.strokeColor || 'none'}
                      strokeWidth={(el.strokeWidth || 1) * 0.5}
                    />
                  )}
                  {el.type === 'arrow' && el.endX && el.endY && (
                    <line
                      x1={el.x}
                      y1={el.y}
                      x2={el.endX}
                      y2={el.endY}
                      stroke={displayColor(el.strokeColor)}
                      strokeWidth={(el.strokeWidth || 1) * 0.5}
                    />
                  )}
                  {el.type === 'path' && el.points && el.points.length > 1 && (
                    <path
                      d={el.points.map((p, i) =>
                        i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`
                      ).join(' ')}
                      fill="none"
                      stroke={displayColor(el.strokeColor)}
                      strokeWidth={(el.strokeWidth || 1) * 0.5}
                    />
                  )}
                  {el.type === 'sticky' && (
                    <rect
                      x={el.x}
                      y={el.y}
                      width={el.width || 200}
                      height={el.height || 200}
                      fill={el.color || '#FFE500'}
                    />
                  )}
                </g>
              ))}
              
              {/* Viewport indicator */}
              <rect
                x={-panPosition.x}
                y={-panPosition.y}
                width={viewportSizeRef.current.width * 100 / zoom}
                height={viewportSizeRef.current.height * 100 / zoom}
                fill="none"
                stroke="#0073ea"
                strokeWidth="2"
                strokeDasharray="4,2"
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}