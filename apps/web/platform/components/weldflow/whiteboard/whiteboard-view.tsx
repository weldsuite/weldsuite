
import { useState, useRef, useEffect, useCallback } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { Button } from '@weldsuite/ui/components/button';
import { ProjectToolbar } from '@/components/weldflow/project-toolbar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  MousePointer2,
  Square,
  Circle,
  Type,
  StickyNote,
  Pen,
  Eraser,
  Hand,
  Search,
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
  Lock,
  Unlock,
  Link,
  List,
  ListOrdered,
  BringToFront,
  SendToBack,
  ArrowUp,
  ArrowDown,
  Clipboard,
  ClipboardPaste,
  ChevronLeft
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

type Tool = 'select' | 'pan' | 'rectangle' | 'circle' | 'text' | 'sticky' | 'pen' | 'eraser' | 'arrow';

type ArrowType = 'line' | 'arrow' | 'elbow';

interface ErasedStroke {
  points: { x: number; y: number }[];
  size: number;
}

interface WhiteboardElement {
  id: string;
  type: 'rectangle' | 'circle' | 'text' | 'sticky' | 'path' | 'arrow';
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number; // Legacy: for backwards compatibility with old circles
  radiusX?: number; // For ellipse horizontal radius
  radiusY?: number; // For ellipse vertical radius
  text?: string;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  points?: { x: number; y: number }[];
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline';
  textAlign?: 'left' | 'center' | 'right';
  link?: string;
  locked?: boolean;
  endX?: number;
  endY?: number;
  erasedPaths?: ErasedStroke[];
  arrowType?: ArrowType;
  // Connection properties - which elements this arrow connects
  startElementId?: string;
  startConnectionPoint?: 'top' | 'right' | 'bottom' | 'left';
  endElementId?: string;
  endConnectionPoint?: 'top' | 'right' | 'bottom' | 'left';
  // Custom curve control point offset (for manual curve adjustment)
  curveControlX?: number;
  curveControlY?: number;
  // Border radius for rectangles
  borderRadius?: number;
}

interface WhiteboardViewProps {
  projectId: string;
  whiteboardId?: string;
  initialElements?: WhiteboardElement[];
  onBack?: () => void;
}

export function WhiteboardView({ projectId, whiteboardId, initialElements = [], onBack }: WhiteboardViewProps) {
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
    userColor,
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
  const [elements, setElements] = useState<WhiteboardElement[]>(initialElements);
  const [isSaving, setIsSaving] = useState(false);

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
  const zoomLevels = [0.025, 0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5]; // Same as commerce builder
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
  const [resizeStartPoint, setResizeStartPoint] = useState({ x: 0, y: 0 });
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
      broadcastElementUpdate(selectedElement, updates);
    }
  }, [selectedElement, broadcastElementUpdate]);
  
  // Update stroke width for selected element
  useEffect(() => {
    if (selectedElement && tool !== 'eraser') {
      const element = elements.find(el => el.id === selectedElement);
      if (element && (element.type === 'rectangle' || element.type === 'circle' || 
          element.type === 'arrow' || element.type === 'path')) {
        updateSelectedElement({ strokeWidth });
      }
    }
  }, [strokeWidth, tool]);
  
  // Update font size for selected element
  useEffect(() => {
    if (selectedElement) {
      const element = elements.find(el => el.id === selectedElement);
      if (element && (element.type === 'text' || element.type === 'sticky')) {
        updateSelectedElement({ fontSize });
      }
    }
  }, [fontSize]);
  
  // Update fill mode for selected element  
  useEffect(() => {
    if (selectedElement) {
      const element = elements.find(el => el.id === selectedElement);
      if (element && (element.type === 'rectangle' || element.type === 'circle')) {
        const newColor = fillMode === 'stroke' ? 'transparent' : (element.color === 'transparent' ? selectedColor : element.color);
        const newStrokeColor = fillMode === 'fill' ? 'transparent' : (element.strokeColor === 'transparent' ? strokeColor : element.strokeColor);
        updateSelectedElement({ 
          color: newColor,
          strokeColor: newStrokeColor 
        });
      }
    }
  }, [fillMode]);
  
  // Sync properties when selecting an element
  useEffect(() => {
    if (selectedElement && tool !== 'eraser') {
      const element = elements.find(el => el.id === selectedElement);
      if (element) {
        // Sync stroke width
        if ('strokeWidth' in element && element.strokeWidth) {
          setStrokeWidth(element.strokeWidth);
        }
        // Sync font size
        if ('fontSize' in element && element.fontSize) {
          setFontSize(element.fontSize);
        }
        // Sync fill mode
        if (element.type === 'rectangle' || element.type === 'circle') {
          const hasTransparentFill = element.color === 'transparent';
          const hasTransparentStroke = element.strokeColor === 'transparent';
          if (hasTransparentFill && !hasTransparentStroke) {
            setFillMode('stroke');
          } else if (!hasTransparentFill && hasTransparentStroke) {
            setFillMode('fill');
          } else {
            setFillMode('both');
          }
        }
      }
    }
  }, [selectedElement, tool]);

  // Handle document-level mouse events during resize/drag/connection to prevent losing track when hovering over toolbar
  useEffect(() => {
    if (!isResizing && !isDraggingElement && !isPanning && !isDrawing && !isDrawingConnection && !isDraggingArrowHandle) return;

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

        if (dragElementsStart.size > 0) {
          setElements(prev => prev.map(el => {
            const startPos = dragElementsStart.get(el.id);
            if (!startPos) return el;
            const updates: Partial<WhiteboardElement> = { x: startPos.x + deltaX, y: startPos.y + deltaY };
            if (el.type === 'arrow' && startPos.endX !== undefined && startPos.endY !== undefined) {
              updates.endX = startPos.endX + deltaX;
              updates.endY = startPos.endY + deltaY;
            }
            if (el.type === 'path' && startPos.points) {
              updates.points = startPos.points.map(p => ({ x: p.x + deltaX, y: p.y + deltaY }));
            }
            return { ...el, ...updates };
          }));
        } else {
          setElements(prev => prev.map(el => {
            if (el.id !== selectedElement) return el;
            const updates: Partial<WhiteboardElement> = { x: dragElementStart.x + deltaX, y: dragElementStart.y + deltaY };
            if (el.type === 'arrow' && dragElementStart.endX !== undefined && dragElementStart.endY !== undefined) {
              updates.endX = dragElementStart.endX + deltaX;
              updates.endY = dragElementStart.endY + deltaY;
            }
            if (el.type === 'path' && dragElementStart.points) {
              updates.points = dragElementStart.points.map(p => ({ x: p.x + deltaX, y: p.y + deltaY }));
            }
            return { ...el, ...updates };
          }));
        }
        return;
      }

      if (isResizing && resizeHandle && selectedElement) {
        const element = elements.find(el => el.id === selectedElement);
        if (!element) return;

        const minSize = 10;

        if (element.type === 'circle') {
          let fixedX: number, fixedY: number;
          switch (resizeHandle) {
            case 'se': fixedX = resizeStartSize.x; fixedY = resizeStartSize.y; break;
            case 'sw': fixedX = resizeStartSize.x + resizeStartSize.width; fixedY = resizeStartSize.y; break;
            case 'ne': fixedX = resizeStartSize.x; fixedY = resizeStartSize.y + resizeStartSize.height; break;
            case 'nw': fixedX = resizeStartSize.x + resizeStartSize.width; fixedY = resizeStartSize.y + resizeStartSize.height; break;
            default: fixedX = resizeStartSize.x; fixedY = resizeStartSize.y;
          }

          let newWidth = Math.max(minSize, Math.abs(point.x - fixedX));
          let newHeight = Math.max(minSize, Math.abs(point.y - fixedY));
          let newRx = newWidth / 2;
          let newRy = newHeight / 2;

          const mouseRight = point.x >= fixedX;
          const mouseDown = point.y >= fixedY;

          if (e.shiftKey) {
            const maxDimension = Math.max(newWidth, newHeight);
            newRx = maxDimension / 2;
            newRy = maxDimension / 2;
          }

          const newCenterX = mouseRight ? fixedX + newRx : fixedX - newRx;
          const newCenterY = mouseDown ? fixedY + newRy : fixedY - newRy;

          setElements(prev => prev.map(el =>
            el.id === selectedElement
              ? { ...el, radiusX: newRx, radiusY: newRy, x: newCenterX, y: newCenterY }
              : el
          ));
        } else if (element.type === 'rectangle' || element.type === 'sticky') {
          let fixedX: number, fixedY: number;
          switch (resizeHandle) {
            case 'se': fixedX = resizeStartSize.x; fixedY = resizeStartSize.y; break;
            case 'sw': fixedX = resizeStartSize.x + resizeStartSize.width; fixedY = resizeStartSize.y; break;
            case 'ne': fixedX = resizeStartSize.x; fixedY = resizeStartSize.y + resizeStartSize.height; break;
            case 'nw': fixedX = resizeStartSize.x + resizeStartSize.width; fixedY = resizeStartSize.y + resizeStartSize.height; break;
            default: fixedX = resizeStartSize.x; fixedY = resizeStartSize.y;
          }

          let newX = Math.min(fixedX, point.x);
          let newY = Math.min(fixedY, point.y);
          let newWidth = Math.max(minSize, Math.abs(point.x - fixedX));
          let newHeight = Math.max(minSize, Math.abs(point.y - fixedY));

          if (e.shiftKey) {
            const maxDimension = Math.max(newWidth, newHeight);
            if (point.x < fixedX) newX = fixedX - maxDimension;
            if (point.y < fixedY) newY = fixedY - maxDimension;
            newWidth = maxDimension;
            newHeight = maxDimension;
          }

          setElements(prev => prev.map(el =>
            el.id === selectedElement
              ? { ...el, width: newWidth, height: newHeight, x: newX, y: newY }
              : el
          ));
        }
      }

      // Handle connection drawing
      if (isDrawingConnection && connectionStart) {
        // Check which element is being hovered (cursor inside element) and find nearest connection point
        let elementUnderCursor: string | null = null;
        let nearestPoint: { x: number; y: number } | null = null;
        let nearestPointName: 'top' | 'right' | 'bottom' | 'left' | null = null;
        let nearestPointElement: string | null = null;
        let minDistance = Infinity;
        const snapDistance = 30; // Distance threshold for snapping

        for (const el of elements) {
          if (el.id === connectionStart.elementId) continue;
          if (el.type === 'arrow' || el.type === 'path') continue;

          // Check if cursor is inside this element
          let isInsideElement = false;
          let connectionPoints: {
            top: { x: number; y: number };
            right: { x: number; y: number };
            bottom: { x: number; y: number };
            left: { x: number; y: number };
          } | null = null;

          switch (el.type) {
            case 'rectangle':
            case 'sticky': {
              const centerX = el.x + (el.width || 0) / 2;
              const centerY = el.y + (el.height || 0) / 2;
              connectionPoints = {
                top: { x: centerX, y: el.y },
                right: { x: el.x + (el.width || 0), y: centerY },
                bottom: { x: centerX, y: el.y + (el.height || 0) },
                left: { x: el.x, y: centerY },
              };
              // Check if cursor is inside rectangle
              isInsideElement = point.x >= el.x && point.x <= el.x + (el.width || 0) &&
                               point.y >= el.y && point.y <= el.y + (el.height || 0);
              break;
            }
            case 'circle': {
              const rx = el.radiusX ?? el.radius ?? 50;
              const ry = el.radiusY ?? el.radius ?? 50;
              connectionPoints = {
                top: { x: el.x, y: el.y - ry },
                right: { x: el.x + rx, y: el.y },
                bottom: { x: el.x, y: el.y + ry },
                left: { x: el.x - rx, y: el.y },
              };
              // Check if cursor is inside ellipse (using ellipse equation)
              const normalizedDist = Math.pow(point.x - el.x, 2) / (rx * rx) + Math.pow(point.y - el.y, 2) / (ry * ry);
              isInsideElement = normalizedDist <= 1;
              break;
            }
            case 'text': {
              const textWidth = Math.max(100, (el.text?.length || 0) * (el.fontSize || 16) * 0.6);
              const textHeight = (el.fontSize || 16) * 1.5;
              const centerX = el.x + textWidth / 2;
              connectionPoints = {
                top: { x: centerX, y: el.y - textHeight },
                right: { x: el.x + textWidth, y: el.y - textHeight / 2 },
                bottom: { x: centerX, y: el.y },
                left: { x: el.x, y: el.y - textHeight / 2 },
              };
              // Check if cursor is inside text bounding box
              isInsideElement = point.x >= el.x && point.x <= el.x + textWidth &&
                               point.y >= el.y - textHeight && point.y <= el.y;
              break;
            }
          }

          // Track if cursor is inside any element (to show connection points)
          if (isInsideElement && !elementUnderCursor) {
            elementUnderCursor = el.id;
          }

          if (connectionPoints) {
            // Check distance to each connection point for snapping
            for (const [pointName, pointPos] of Object.entries(connectionPoints) as [('top' | 'right' | 'bottom' | 'left'), { x: number; y: number }][]) {
              const dist = Math.sqrt(Math.pow(point.x - pointPos.x, 2) + Math.pow(point.y - pointPos.y, 2));
              if (dist < snapDistance && dist < minDistance) {
                minDistance = dist;
                nearestPoint = pointPos;
                nearestPointName = pointName;
                nearestPointElement = el.id;
              }
            }
          }
        }

        // Determine which element to show connection points on
        // Priority: element with snapped point > element cursor is inside
        const hoveredElement = nearestPointElement || elementUnderCursor;

        // Snap to nearest connection point if within range, otherwise use mouse position
        if (nearestPoint && nearestPointElement) {
          setConnectionEndPoint(nearestPoint);
          setHoveredConnectionElement(nearestPointElement);
          setSnappedConnectionPoint(nearestPointName);
        } else {
          setConnectionEndPoint(point);
          setHoveredConnectionElement(elementUnderCursor);
          setSnappedConnectionPoint(null);
        }
      }

      // Handle arrow handle dragging
      if (isDraggingArrowHandle && selectedElement && arrowDragStart) {
        const arrowElement = elements.find(el => el.id === selectedElement);
        if (arrowElement && arrowElement.type === 'arrow') {
          switch (isDraggingArrowHandle) {
            case 'start':
              // Move the start point of the arrow
              setElements(prev => prev.map(el =>
                el.id === selectedElement
                  ? {
                      ...el,
                      x: point.x,
                      y: point.y,
                      // Clear start connection when manually moving
                      startElementId: undefined,
                      startConnectionPoint: undefined,
                    }
                  : el
              ));
              break;
            case 'end':
              // Move the end point of the arrow
              setElements(prev => prev.map(el =>
                el.id === selectedElement
                  ? {
                      ...el,
                      endX: point.x,
                      endY: point.y,
                      // Clear end connection when manually moving
                      endElementId: undefined,
                      endConnectionPoint: undefined,
                    }
                  : el
              ));
              break;
            case 'curve':
              // Adjust the curve control point
              setElements(prev => prev.map(el =>
                el.id === selectedElement
                  ? {
                      ...el,
                      curveControlX: point.x,
                      curveControlY: point.y,
                    }
                  : el
              ));
              break;
          }
        }
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
  }, [isResizing, isDraggingElement, isPanning, isDrawing, isDrawingConnection, isDraggingArrowHandle, isMiddleMouseDown, selectedElement, resizeHandle, resizeStartSize, dragStartPos, dragElementStart, dragElementsStart, panStart, panPosition, zoom, elements, connectionStart, arrowDragStart]);

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
    const elementsJson = JSON.stringify(elementsToSave);
    // Skip if nothing changed
    if (elementsJson === lastSavedElementsRef.current) {
      return;
    }

    try {
      setIsSaving(true);
      const client = await getClient();
      // `PUT /projects/:projectId/whiteboard[/:id]` never existed (api-worker mounts
      // no projects routes). Canonical surface: `PATCH /api/whiteboards/:id` to update
      // an existing board, `POST /api/whiteboards` (with projectId) to create one.
      // The client throws on a non-2xx, so reaching the next line means it saved.
      if (whiteboardId) {
        await client.patch<{ data: any }>(`/whiteboards/${whiteboardId}`, {
          elements: elementsToSave,
        });
      } else {
        await client.post<{ data: any }>('/whiteboards', {
          projectId,
          elements: elementsToSave,
        });
      }
      lastSavedElementsRef.current = elementsJson;
    } catch (error) {
      console.error('Failed to save whiteboard:', error);
      toast.error(st('sweep.weldflow.whiteboardView.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [projectId, whiteboardId, getClient]);

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
      saveWhiteboard(elements);
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

    const unsubAdd = onElementAdd((element: WhiteboardElement, userId: string) => {
      setElements(prev => [...prev, element]);
    });

    const unsubUpdate = onElementUpdate((elementId: string, changes: Partial<WhiteboardElement>, userId: string) => {
      setElements(prev => prev.map(el =>
        el.id === elementId ? { ...el, ...changes } : el
      ));
    });

    const unsubDelete = onElementDelete((elementId: string, userId: string) => {
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
    broadcastSelectionChange(selectedIds);
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
    broadcastElementAdd(element);
  }, [broadcastElementAdd, isConnected]);

  const updateElementWithBroadcast = useCallback((elementId: string, changes: Partial<WhiteboardElement>) => {
    setElements(prev => prev.map(el =>
      el.id === elementId ? { ...el, ...changes } : el
    ));
    broadcastElementUpdate(elementId, changes);
  }, [broadcastElementUpdate]);

  const deleteElementWithBroadcast = useCallback((elementId: string) => {
    setElements(prev => prev.filter(el => el.id !== elementId));
    broadcastElementDelete(elementId);
  }, [broadcastElementDelete]);

  // Get connection points for an element (top, right, bottom, left)
  const getConnectionPoints = useCallback((element: WhiteboardElement): {
    top: { x: number; y: number };
    right: { x: number; y: number };
    bottom: { x: number; y: number };
    left: { x: number; y: number };
  } | null => {
    switch (element.type) {
      case 'rectangle':
      case 'sticky': {
        const centerX = element.x + (element.width || 0) / 2;
        const centerY = element.y + (element.height || 0) / 2;
        return {
          top: { x: centerX, y: element.y },
          right: { x: element.x + (element.width || 0), y: centerY },
          bottom: { x: centerX, y: element.y + (element.height || 0) },
          left: { x: element.x, y: centerY },
        };
      }
      case 'circle': {
        const rx = element.radiusX ?? element.radius ?? 50;
        const ry = element.radiusY ?? element.radius ?? 50;
        return {
          top: { x: element.x, y: element.y - ry },
          right: { x: element.x + rx, y: element.y },
          bottom: { x: element.x, y: element.y + ry },
          left: { x: element.x - rx, y: element.y },
        };
      }
      case 'text': {
        // Use stored bounding box if available for accurate positioning
        const storedBbox = textBoundingBoxesRef.current.get(element.id);
        if (storedBbox) {
          const centerX = storedBbox.x + storedBbox.width / 2;
          const centerY = storedBbox.y + storedBbox.height / 2;
          return {
            top: { x: centerX, y: storedBbox.y - 4 },
            right: { x: storedBbox.x + storedBbox.width + 6, y: centerY },
            bottom: { x: centerX, y: storedBbox.y + storedBbox.height + 4 },
            left: { x: storedBbox.x - 6, y: centerY },
          };
        }
        // Fallback to estimation
        const textWidth = Math.max(100, (element.text?.length || 0) * (element.fontSize || 16) * 0.6);
        const textHeight = (element.fontSize || 16) * 1.5;
        const centerX = element.x + textWidth / 2;
        return {
          top: { x: centerX, y: element.y - textHeight },
          right: { x: element.x + textWidth, y: element.y - textHeight / 2 },
          bottom: { x: centerX, y: element.y },
          left: { x: element.x, y: element.y - textHeight / 2 },
        };
      }
      default:
        return null;
    }
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

      let updates: Partial<WhiteboardElement> = {};

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
  }, [selectedElement, undo, redo, addToHistory, editingElement]);

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
  
  // Performance optimization constants
  const ERASER_RING_THICKNESS = 3; // Single constant for ring thickness
  const MAX_INTERPOLATION_STEPS = 5; // Limit interpolation for performance
  const ERASER_PROCESS_THRESHOLD = 5; // Minimum movement before processing
  
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

  // Calculate curve control points for an arrow element
  const getArrowCurvePoints = (element: WhiteboardElement) => {
    if (!element.endX || !element.endY) return null;

    const startX = element.x;
    const startY = element.y;
    const endX = element.endX;
    const endY = element.endY;

    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const curveOffset = Math.min(distance * 0.5, 150);

    let cp1x: number, cp1y: number, cp2x: number, cp2y: number;

    // Check if there's a custom curve control point
    if (element.curveControlX !== undefined && element.curveControlY !== undefined) {
      // Use quadratic-like control with single control point
      cp1x = element.curveControlX;
      cp1y = element.curveControlY;
      cp2x = element.curveControlX;
      cp2y = element.curveControlY;
    } else if (element.startConnectionPoint && element.endConnectionPoint) {
      // Connected arrows: curve flows naturally from connection points
      switch (element.startConnectionPoint) {
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

      switch (element.endConnectionPoint) {
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
      // Non-connected arrows: straight line. Place control points 1/3 and 2/3
      // along the segment so the cubic-bezier renders as a straight line while
      // still giving renderArrowHeadWithTangent a non-zero tangent vector at
      // the end.
      cp1x = startX + dx / 3;
      cp1y = startY + dy / 3;
      cp2x = startX + (2 * dx) / 3;
      cp2y = startY + (2 * dy) / 3;
    }

    // Calculate midpoint of curve for the control handle
    // For a cubic bezier, the point at t=0.5 is: 0.125*P0 + 0.375*P1 + 0.375*P2 + 0.125*P3
    const curveMidX = 0.125 * startX + 0.375 * cp1x + 0.375 * cp2x + 0.125 * endX;
    const curveMidY = 0.125 * startY + 0.375 * cp1y + 0.375 * cp2y + 0.125 * endY;

    return { startX, startY, endX, endY, cp1x, cp1y, cp2x, cp2y, curveMidX, curveMidY };
  };

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
      <>
        <path
          d={`M ${x2 - headLength * Math.cos(angle - headAngle)} ${y2 - headLength * Math.sin(angle - headAngle)} L ${x2} ${y2} L ${x2 - headLength * Math.cos(angle + headAngle)} ${y2 - headLength * Math.sin(angle + headAngle)}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    );
  };

  // Canvas bounds constants
  const CANVAS_WIDTH = 16000;
  const CANVAS_HEIGHT = 9000;
  const CANVAS_MARGIN = 500; // Gray border area
  const TOTAL_CANVAS_WIDTH = CANVAS_WIDTH + CANVAS_MARGIN * 2;
  const TOTAL_CANVAS_HEIGHT = CANVAS_HEIGHT + CANVAS_MARGIN * 2;

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
  const screenToCanvas = (screenX: number, screenY: number) => {
    const { left, top } = canvasRectRef.current;
    return {
      x: (screenX - left - panPosition.x) / zoom,
      y: (screenY - top - panPosition.y) / zoom
    };
  };

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

  // Simplify path by removing redundant points
  const simplifyPath = (points: { x: number; y: number }[]): { x: number; y: number }[] => {
    if (points.length <= 2) return points;
    
    const simplified: { x: number; y: number }[] = [points[0]];
    let prevPoint = points[0];
    
    for (let i = 1; i < points.length - 1; i++) {
      const point = points[i];
      const nextPoint = points[i + 1];
      
      // Calculate angle between segments
      const angle1 = Math.atan2(point.y - prevPoint.y, point.x - prevPoint.x);
      const angle2 = Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x);
      const angleDiff = Math.abs(angle1 - angle2);
      
      // Keep point if angle changes significantly or distance is large
      const dist = Math.sqrt(
        Math.pow(point.x - prevPoint.x, 2) + Math.pow(point.y - prevPoint.y, 2)
      );
      
      if (angleDiff > 0.1 || dist > 10) {
        simplified.push(point);
        prevPoint = point;
      }
    }
    
    simplified.push(points[points.length - 1]);
    return simplified;
  };

  // Batch process eraser updates for performance
  const processBatchedErasing = useCallback(() => {
    if (eraserUpdateQueue.current.length === 0) return;
    
    const updates = [...eraserUpdateQueue.current];
    eraserUpdateQueue.current = [];

    setElements(prevElements => {
      const elementsToRemove = new Set<string>();

      // Check which elements should be removed
      for (const element of prevElements) {
        for (const { point: eraserPoint, size: currentEraserSize } of updates) {
          // Quick bounds check for performance
          let quickReject = false;
          switch (element.type) {
            case 'rectangle':
            case 'sticky':
              quickReject = eraserPoint.x < element.x! - currentEraserSize - 10 ||
                           eraserPoint.x > element.x! + element.width! + currentEraserSize + 10 ||
                           eraserPoint.y < element.y! - currentEraserSize - 10 ||
                           eraserPoint.y > element.y! + element.height! + currentEraserSize + 10;
              break;
            case 'circle':
              const circleRx = element.radiusX ?? element.radius ?? 50;
              const circleRy = element.radiusY ?? element.radius ?? 50;
              const maxRadius = Math.max(circleRx, circleRy);
              const circleDist = Math.sqrt(
                Math.pow(eraserPoint.x - element.x, 2) +
                Math.pow(eraserPoint.y - element.y, 2)
              );
              quickReject = circleDist > maxRadius + currentEraserSize + 10;
              break;
          }

          if (quickReject) continue;

          // Check actual intersection
          let isIntersecting = false;

          switch (element.type) {
            case 'path':
              if (element.points && element.points.length > 1) {
                for (let i = 0; i < element.points.length - 1; i++) {
                  const distToSegment = pointToLineDistance(
                    eraserPoint,
                    element.points[i],
                    element.points[i + 1]
                  );
                  if (distToSegment <= currentEraserSize) {
                    isIntersecting = true;
                    break;
                  }
                }
              }
              break;

            case 'rectangle':
            case 'sticky':
              const closestX = Math.max(element.x!, Math.min(eraserPoint.x, element.x! + element.width!));
              const closestY = Math.max(element.y!, Math.min(eraserPoint.y, element.y! + element.height!));
              const distToRect = Math.sqrt(
                Math.pow(eraserPoint.x - closestX, 2) +
                Math.pow(eraserPoint.y - closestY, 2)
              );
              isIntersecting = distToRect <= currentEraserSize;
              break;

            case 'circle':
              // For ellipse intersection, check if eraser point is close to ellipse boundary
              const eraseRx = element.radiusX ?? element.radius ?? 50;
              const eraseRy = element.radiusY ?? element.radius ?? 50;
              // Normalize the point to unit circle space and check distance
              const normalizedX = (eraserPoint.x - element.x) / (eraseRx + currentEraserSize);
              const normalizedY = (eraserPoint.y - element.y) / (eraseRy + currentEraserSize);
              isIntersecting = (normalizedX * normalizedX + normalizedY * normalizedY) <= 1;
              break;

            case 'arrow':
              if (element.endX !== undefined && element.endY !== undefined) {
                const distToLine = pointToLineDistance(
                  eraserPoint,
                  { x: element.x, y: element.y },
                  { x: element.endX, y: element.endY }
                );
                isIntersecting = distToLine <= currentEraserSize;
              }
              break;

            case 'text':
              const textWidth = (element.text?.length || 0) * (element.fontSize || 16) * 0.6;
              const textHeight = element.fontSize || 16;
              const textClosestX = Math.max(element.x, Math.min(eraserPoint.x, element.x + textWidth));
              const textClosestY = Math.max(element.y - textHeight, Math.min(eraserPoint.y, element.y));
              const distToText = Math.sqrt(
                Math.pow(eraserPoint.x - textClosestX, 2) +
                Math.pow(eraserPoint.y - textClosestY, 2)
              );
              isIntersecting = distToText <= currentEraserSize;
              break;
          }

          if (isIntersecting) {
            elementsToRemove.add(element.id);
            break; // No need to check more eraser points for this element
          }
        }
      }

      // Broadcast deletions to other clients
      if (elementsToRemove.size > 0) {
        elementsToRemove.forEach(id => broadcastElementDelete(id));
      }

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
  
  // Original processErasing kept for compatibility but now uses batching
  const processErasing = (eraserPoint: { x: number; y: number }, currentEraserSize: number, immediate = false) => {
    if (immediate) {
      // Process immediately without any delay
      if (eraserBatchTimer.current) {
        clearTimeout(eraserBatchTimer.current);
      }
      eraserUpdateQueue.current = [{ point: eraserPoint, size: currentEraserSize }];
      processBatchedErasing();
    } else {
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
    }
  };

  // Calculate distance from point to line segment
  const pointToLineDistance = (
    point: { x: number; y: number },
    lineStart: { x: number; y: number },
    lineEnd: { x: number; y: number }
  ): number => {
    const A = point.x - lineStart.x;
    const B = point.y - lineStart.y;
    const C = lineEnd.x - lineStart.x;
    const D = lineEnd.y - lineStart.y;
    
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    
    if (lenSq !== 0) {
      param = dot / lenSq;
    }
    
    let xx, yy;
    
    if (param < 0) {
      xx = lineStart.x;
      yy = lineStart.y;
    } else if (param > 1) {
      xx = lineEnd.x;
      yy = lineEnd.y;
    } else {
      xx = lineStart.x + param * C;
      yy = lineStart.y + param * D;
    }
    
    const dx = point.x - xx;
    const dy = point.y - yy;
    
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Check if a point is inside a selection box
  const isPointInSelectionBox = (x: number, y: number, box: typeof selectionBox) => {
    if (!box) return false;
    const minX = Math.min(box.startX, box.endX);
    const maxX = Math.max(box.startX, box.endX);
    const minY = Math.min(box.startY, box.endY);
    const maxY = Math.max(box.startY, box.endY);
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  };

  // Strict segment-vs-segment intersection (excludes collinear/endpoint-only
  // touches). Used to test if a line-shaped element actually crosses the
  // marquee — bounding-box overlap alone gives false positives for diagonals.
  const segmentsIntersect = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number
  ): boolean => {
    const cross = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
      (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const d1 = cross(cx, cy, dx, dy, ax, ay);
    const d2 = cross(cx, cy, dx, dy, bx, by);
    const d3 = cross(ax, ay, bx, by, cx, cy);
    const d4 = cross(ax, ay, bx, by, dx, dy);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };

  // Check if an element intersects with the selection box (partial selection)
  const isElementInSelectionBox = (element: WhiteboardElement, box: typeof selectionBox) => {
    if (!box) return false;
    
    const minX = Math.min(box.startX, box.endX);
    const maxX = Math.max(box.startX, box.endX);
    const minY = Math.min(box.startY, box.endY);
    const maxY = Math.max(box.startY, box.endY);
    
    switch (element.type) {
      case 'rectangle':
      case 'sticky':
        // Check if rectangles intersect (not just contained)
        return !(element.x! + element.width! < minX || 
                element.x! > maxX ||
                element.y! + element.height! < minY || 
                element.y! > maxY);
      case 'circle':
        // Check if ellipse intersects with box using bounding box check
        const selRx = element.radiusX ?? element.radius ?? 50;
        const selRy = element.radiusY ?? element.radius ?? 50;
        // Simple bounding box intersection for ellipse
        return !(element.x + selRx < minX ||
                element.x - selRx > maxX ||
                element.y + selRy < minY ||
                element.y - selRy > maxY);
      case 'text':
        const textWidth = (element.text?.length || 0) * (element.fontSize || 16) * 0.6;
        const textHeight = element.fontSize || 16;
        // Check if text box intersects
        return !(element.x + textWidth < minX || 
                element.x > maxX ||
                element.y < minY || 
                element.y - textHeight > maxY);
      case 'arrow': {
        // The line is selected only if its endpoints are inside the marquee
        // OR the actual segment crosses one of the marquee sides — not just
        // if the segment's bounding box overlaps the marquee (which would
        // false-positive for long diagonals).
        const startInBox = element.x >= minX && element.x <= maxX &&
                          element.y >= minY && element.y <= maxY;
        const endInBox = element.endX! >= minX && element.endX! <= maxX &&
                        element.endY! >= minY && element.endY! <= maxY;
        if (startInBox || endInBox) return true;
        const ax = element.x, ay = element.y;
        const bx = element.endX!, by = element.endY!;
        return (
          segmentsIntersect(ax, ay, bx, by, minX, minY, maxX, minY) || // top edge
          segmentsIntersect(ax, ay, bx, by, maxX, minY, maxX, maxY) || // right edge
          segmentsIntersect(ax, ay, bx, by, maxX, maxY, minX, maxY) || // bottom edge
          segmentsIntersect(ax, ay, bx, by, minX, maxY, minX, minY)    // left edge
        );
      }
      case 'path':
        if (element.points && element.points.length > 0) {
          // A point inside the marquee selects the path. Otherwise, check
          // whether any segment of the stroke crosses a marquee side so a
          // marquee drawn over the path's middle still selects it.
          if (element.points.some(p =>
            p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
          )) return true;
          for (let i = 0; i < element.points.length - 1; i++) {
            const p1 = element.points[i];
            const p2 = element.points[i + 1];
            if (
              segmentsIntersect(p1.x, p1.y, p2.x, p2.y, minX, minY, maxX, minY) ||
              segmentsIntersect(p1.x, p1.y, p2.x, p2.y, maxX, minY, maxX, maxY) ||
              segmentsIntersect(p1.x, p1.y, p2.x, p2.y, maxX, maxY, minX, maxY) ||
              segmentsIntersect(p1.x, p1.y, p2.x, p2.y, minX, maxY, minX, minY)
            ) return true;
          }
          return false;
        }
        return false;
      default:
        return false;
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
      setIsPanning(true);
      setPanStart({
        x: e.clientX - panPosition.x,
        y: e.clientY - panPosition.y
      });
      return;
    }

    // Check if clicking on a resize handle
    if (tool === 'select' && selectedElement) {
      const element = elements.find(el => el.id === selectedElement);
      if (element && (element.type === 'sticky' || element.type === 'rectangle' || element.type === 'circle')) {
        const handleSize = 8 / zoom;

        // Calculate actual displayed height (must match rendering logic)
        let elementHeight = element.height || 0;
        let elementWidth = element.width || 0;
        let elementX = element.x || 0;
        let elementY = element.y || 0;

        if (element.type === 'sticky') {
          const textLines = (element.text || '').split('\n');
          const lineHeight = (element.fontSize || 16) * 1.5;
          const minHeight = 200;
          const padding = 24;
          const autoCalculatedHeight = Math.max(minHeight, (textLines.length * lineHeight) + padding + 20);
          // Use stored height if available, otherwise use auto-calculated
          elementHeight = element.height || autoCalculatedHeight;
        } else if (element.type === 'circle') {
          // For circles/ellipses, calculate bounding box from center and radii
          const rx = element.radiusX ?? element.radius ?? 50;
          const ry = element.radiusY ?? element.radius ?? 50;
          elementX = element.x - rx;
          elementY = element.y - ry;
          elementWidth = rx * 2;
          elementHeight = ry * 2;
        }

        // Check each corner handle
        const handles = {
          nw: { x: elementX, y: elementY },
          ne: { x: elementX + elementWidth, y: elementY },
          sw: { x: elementX, y: elementY + elementHeight },
          se: { x: elementX + elementWidth, y: elementY + elementHeight },
        };

        for (const [handleName, handlePos] of Object.entries(handles)) {
          if (
            point.x >= handlePos.x - handleSize &&
            point.x <= handlePos.x + handleSize &&
            point.y >= handlePos.y - handleSize &&
            point.y <= handlePos.y + handleSize
          ) {
            e.preventDefault(); // Prevent text selection
            setIsResizing(true);
            setResizeHandle(handleName as 'nw' | 'ne' | 'sw' | 'se');
            setResizeStartPoint(point);
            setResizeStartSize({
              width: elementWidth,
              height: elementHeight,
              x: elementX,
              y: elementY,
            });
            return;
          }
        }
      }

      // Check if clicking on arrow handles
      if (element && element.type === 'arrow') {
        const curvePoints = getArrowCurvePoints(element);
        if (curvePoints) {
          const handleSize = 10 / zoom;

          // Check start handle
          if (Math.abs(point.x - curvePoints.startX) <= handleSize &&
              Math.abs(point.y - curvePoints.startY) <= handleSize) {
            e.preventDefault();
            setIsDraggingArrowHandle('start');
            setArrowDragStart({ x: curvePoints.startX, y: curvePoints.startY });
            return;
          }

          // Check end handle
          if (Math.abs(point.x - curvePoints.endX) <= handleSize &&
              Math.abs(point.y - curvePoints.endY) <= handleSize) {
            e.preventDefault();
            setIsDraggingArrowHandle('end');
            setArrowDragStart({ x: curvePoints.endX, y: curvePoints.endY });
            return;
          }

          // Check curve control handle
          if (Math.abs(point.x - curvePoints.curveMidX) <= handleSize &&
              Math.abs(point.y - curvePoints.curveMidY) <= handleSize) {
            e.preventDefault();
            setIsDraggingArrowHandle('curve');
            setArrowDragStart({ x: curvePoints.curveMidX, y: curvePoints.curveMidY });
            return;
          }
        }
      }
    }

    if (tool === 'select') {
      // Don't interrupt if we're editing text
      if (editingElement) {
        return;
      }

      // Check if clicking on an element (search in reverse to find topmost element first)
      const clickedElement = [...elements].reverse().find(el => {
        switch (el.type) {
          case 'rectangle':
          case 'sticky':
            return point.x >= el.x! && point.x <= el.x! + el.width! &&
                   point.y >= el.y! && point.y <= el.y! + el.height!;
          case 'circle': {
            // Support ellipse with radiusX/radiusY or legacy radius
            const rx = el.radiusX ?? el.radius ?? 50;
            const ry = el.radiusY ?? el.radius ?? 50;
            // Ellipse equation: (x-cx)^2/rx^2 + (y-cy)^2/ry^2 <= 1
            const normalizedDist = Math.pow(point.x - el.x, 2) / (rx * rx) + Math.pow(point.y - el.y, 2) / (ry * ry);
            return normalizedDist <= 1;
          }
          case 'text':
            // Use minimum width for empty text to make it clickable
            const textWidth = Math.max(100, (el.text?.length || 0) * (el.fontSize || 16) * 0.6);
            const textHeight = (el.fontSize || 16) * 1.5;
            return point.x >= el.x && point.x <= el.x + textWidth &&
                   point.y >= el.y - textHeight && point.y <= el.y;
          case 'arrow': {
            // Check proximity to the arrow line. Tolerance scales with zoom so
            // the clickable strip stays ~12px wide on screen at any zoom level.
            const hitTolerance = 12 / zoom;
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
            return distToLine <= hitTolerance;
          }
          case 'path': {
            if (!el.points || el.points.length < 2) return false;
            // Check proximity to any segment of the path. Tolerance scales with
            // zoom so freehand strokes stay clickable at any zoom level.
            const hitTolerance = 12 / zoom;
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
              if (segDist <= hitTolerance) return true;
            }
            return false;
          }
          default:
            return false;
        }
      });

      if (clickedElement) {
        // Check if we have multiple elements selected (either in selectedElements or check if clicked is in selection)
        const hasMultiSelection = selectedElements.size > 1;
        const clickedIsInSelection = selectedElements.has(clickedElement.id);

        if (hasMultiSelection && clickedIsInSelection) {
          // Start dragging all selected elements
          setIsDraggingElement(true);
          setDragStartPos(point);

          // Store starting positions for all selected elements
          const startPositions = new Map<string, { x: number; y: number; endX?: number; endY?: number; points?: { x: number; y: number }[] }>();
          elements.forEach(el => {
            if (selectedElements.has(el.id)) {
              startPositions.set(el.id, {
                x: el.x || 0,
                y: el.y || 0,
                endX: el.endX,
                endY: el.endY,
                points: el.points ? [...el.points] : undefined
              });
            }
          });
          setDragElementsStart(startPositions);
        } else if (hasMultiSelection && !clickedIsInSelection) {
          // Clicked on element outside selection - select only this element
          setSelectedElement(clickedElement.id);
          setSelectedElements(new Set());
          setIsDraggingElement(true);
          setDragStartPos(point);
          setDragElementStart({
            x: clickedElement.x || 0,
            y: clickedElement.y || 0,
            endX: clickedElement.endX,
            endY: clickedElement.endY,
            points: clickedElement.points ? [...clickedElement.points] : undefined,
          });
        } else {
          // Single element or no multi-selection - drag single element
          setSelectedElement(clickedElement.id);
          setSelectedElements(new Set());
          setIsDraggingElement(true);
          setDragStartPos(point);
          setDragElementStart({
            x: clickedElement.x || 0,
            y: clickedElement.y || 0,
            endX: clickedElement.endX,
            endY: clickedElement.endY,
            points: clickedElement.points ? [...clickedElement.points] : undefined,
          });
        }
      } else {
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
      }
      return;
    } else if (tool === 'pan') {
      setIsPanning(true);
      setPanStart({
        x: e.clientX - panPosition.x,
        y: e.clientY - panPosition.y
      });
    } else if (tool === 'pen') {
      setIsDrawing(true);
      setCurrentPath([point]);
      setSelectedElement(null);
      setSelectedElements(new Set());
    } else if (tool === 'eraser') {
      setIsErasing(true);
      setEraserPath([point]);
      // Just process the erasing, don't modify elements unnecessarily
      processErasing(point, eraserSize, true);
      setSelectedElement(null);
      setSelectedElements(new Set());
    } else if (tool === 'rectangle' || tool === 'circle' || tool === 'arrow') {
      setIsDrawing(true);
      setSelectedElement(null);
      setSelectedElements(new Set());
    } else if (tool === 'sticky') {
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
    } else if (tool === 'text') {
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
    }
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
      const deltaX = point.x - dragStartPos.x;
      const deltaY = point.y - dragStartPos.y;

      // Check if dragging multiple elements
      if (dragElementsStart.size > 0) {
        setElements(elements.map(el => {
          const startPos = dragElementsStart.get(el.id);
          if (!startPos) return el;

          const updates: Partial<WhiteboardElement> = {
            x: startPos.x + deltaX,
            y: startPos.y + deltaY,
          };

          // Handle arrow endpoints
          if (el.type === 'arrow' && startPos.endX !== undefined && startPos.endY !== undefined) {
            updates.endX = startPos.endX + deltaX;
            updates.endY = startPos.endY + deltaY;
          }

          // Handle path points
          if (el.type === 'path' && startPos.points) {
            updates.points = startPos.points.map(p => ({
              x: p.x + deltaX,
              y: p.y + deltaY
            }));
          }

          return { ...el, ...updates };
        }));
      } else if (selectedElement) {
        // Single element dragging
        setElements(elements.map(el => {
          if (el.id !== selectedElement) return el;
          const updates: Partial<WhiteboardElement> = {
            x: dragElementStart.x + deltaX,
            y: dragElementStart.y + deltaY,
          };
          if (el.type === 'arrow' && dragElementStart.endX !== undefined && dragElementStart.endY !== undefined) {
            updates.endX = dragElementStart.endX + deltaX;
            updates.endY = dragElementStart.endY + deltaY;
          }
          if (el.type === 'path' && dragElementStart.points) {
            updates.points = dragElementStart.points.map(p => ({ x: p.x + deltaX, y: p.y + deltaY }));
          }
          return { ...el, ...updates };
        }));
      }
      return;
    }

    // Handle corner radius dragging for rectangles
    if (isDraggingCornerRadius && selectedElement && cornerRadiusDragStart) {
      const element = elements.find(el => el.id === selectedElement);
      if (element && element.type === 'rectangle') {
        // Calculate distance from corner towards center
        const maxRadius = Math.min(element.width || 0, element.height || 0) / 2;

        // Distance moved from start position (diagonal towards center)
        const deltaX = point.x - cornerRadiusDragStart.x;
        const deltaY = point.y - cornerRadiusDragStart.y;

        // Calculate based on which corner is being dragged
        let radiusDelta = 0;
        switch (isDraggingCornerRadius) {
          case 'tl': // Top-left: drag towards bottom-right increases radius
            radiusDelta = (deltaX + deltaY) / 2;
            break;
          case 'tr': // Top-right: drag towards bottom-left increases radius
            radiusDelta = (-deltaX + deltaY) / 2;
            break;
          case 'bl': // Bottom-left: drag towards top-right increases radius
            radiusDelta = (deltaX - deltaY) / 2;
            break;
          case 'br': // Bottom-right: drag towards top-left increases radius
            radiusDelta = (-deltaX - deltaY) / 2;
            break;
        }

        const newRadius = Math.max(0, Math.min(maxRadius, cornerRadiusDragStart.initialRadius + radiusDelta));

        setElements(elements.map(el =>
          el.id === selectedElement
            ? { ...el, borderRadius: newRadius }
            : el
        ));
      }
      return;
    }

    if (isResizing && resizeHandle && selectedElement) {
      const element = elements.find(el => el.id === selectedElement);
      if (element && (element.type === 'sticky' || element.type === 'rectangle' || element.type === 'circle')) {
        const minSize = 10; // Minimum size for shapes

        // Handle circle/ellipse resizing - allows free resizing to any shape
        if (element.type === 'circle') {
          // resizeStartSize contains the bounding box: x, y is top-left corner, width/height are dimensions
          // For ellipse, the fixed point is the opposite corner of the bounding box
          let fixedX: number, fixedY: number;
          switch (resizeHandle) {
            case 'se': // Dragging bottom-right, fixed point is top-left
              fixedX = resizeStartSize.x;
              fixedY = resizeStartSize.y;
              break;
            case 'sw': // Dragging bottom-left, fixed point is top-right
              fixedX = resizeStartSize.x + resizeStartSize.width;
              fixedY = resizeStartSize.y;
              break;
            case 'ne': // Dragging top-right, fixed point is bottom-left
              fixedX = resizeStartSize.x;
              fixedY = resizeStartSize.y + resizeStartSize.height;
              break;
            case 'nw': // Dragging top-left, fixed point is bottom-right
              fixedX = resizeStartSize.x + resizeStartSize.width;
              fixedY = resizeStartSize.y + resizeStartSize.height;
              break;
            default:
              fixedX = resizeStartSize.x;
              fixedY = resizeStartSize.y;
          }

          // Calculate new bounding box from fixed point to mouse position
          let newWidth = Math.abs(point.x - fixedX);
          let newHeight = Math.abs(point.y - fixedY);

          // Apply minimum size
          newWidth = Math.max(minSize, newWidth);
          newHeight = Math.max(minSize, newHeight);

          // Calculate new radii and center
          let newRx = newWidth / 2;
          let newRy = newHeight / 2;

          // Determine which direction the mouse is relative to fixed point
          const mouseRight = point.x >= fixedX;
          const mouseDown = point.y >= fixedY;

          let newCenterX: number;
          let newCenterY: number;

          // Shift key for proportional (perfect circle)
          if (e.shiftKey) {
            const maxDimension = Math.max(newWidth, newHeight);
            newRx = maxDimension / 2;
            newRy = maxDimension / 2;

            // Position center based on direction from fixed point
            newCenterX = mouseRight ? fixedX + newRx : fixedX - newRx;
            newCenterY = mouseDown ? fixedY + newRy : fixedY - newRy;
          } else {
            // Center is in the middle of the bounding box
            newCenterX = mouseRight ? fixedX + newRx : fixedX - newRx;
            newCenterY = mouseDown ? fixedY + newRy : fixedY - newRy;
          }

          setElements(elements.map(el =>
            el.id === selectedElement
              ? { ...el, radiusX: newRx, radiusY: newRy, x: newCenterX, y: newCenterY }
              : el
          ));
          return;
        }

        // For rectangles and stickies: calculate based on fixed corner and mouse position
        // The fixed corner is the opposite of the handle being dragged
        let fixedX: number, fixedY: number;
        switch (resizeHandle) {
          case 'se': // Dragging bottom-right, fixed point is top-left
            fixedX = resizeStartSize.x;
            fixedY = resizeStartSize.y;
            break;
          case 'sw': // Dragging bottom-left, fixed point is top-right
            fixedX = resizeStartSize.x + resizeStartSize.width;
            fixedY = resizeStartSize.y;
            break;
          case 'ne': // Dragging top-right, fixed point is bottom-left
            fixedX = resizeStartSize.x;
            fixedY = resizeStartSize.y + resizeStartSize.height;
            break;
          case 'nw': // Dragging top-left, fixed point is bottom-right
            fixedX = resizeStartSize.x + resizeStartSize.width;
            fixedY = resizeStartSize.y + resizeStartSize.height;
            break;
          default:
            fixedX = resizeStartSize.x;
            fixedY = resizeStartSize.y;
        }

        // Calculate new bounds - allows flipping when dragging past the fixed corner
        let newX = Math.min(fixedX, point.x);
        let newY = Math.min(fixedY, point.y);
        let newWidth = Math.abs(point.x - fixedX);
        let newHeight = Math.abs(point.y - fixedY);

        // Check if shift key is pressed for equal proportions
        if (e.shiftKey) {
          const maxDimension = Math.max(newWidth, newHeight);
          // Adjust position based on which quadrant the mouse is relative to fixed point
          if (point.x < fixedX) {
            newX = fixedX - maxDimension;
          }
          if (point.y < fixedY) {
            newY = fixedY - maxDimension;
          }
          newWidth = maxDimension;
          newHeight = maxDimension;
        }

        // Apply minimum size
        newWidth = Math.max(minSize, newWidth);
        newHeight = Math.max(minSize, newHeight);

        setElements(elements.map(el =>
          el.id === selectedElement
            ? { ...el, width: newWidth, height: newHeight, x: newX, y: newY }
            : el
        ));
      }
      return;
    }

    if (isSelecting && tool === 'select') {
      // Update selection box
      setSelectionBox(prev => prev ? {
        ...prev,
        endX: point.x,
        endY: point.y
      } : null);
      
      // Update selected elements based on selection box
      if (selectionBox) {
        const newSelectedElements = new Set<string>();
        elements.forEach(el => {
          if (isElementInSelectionBox(el, {
            ...selectionBox,
            endX: point.x,
            endY: point.y
          })) {
            newSelectedElements.add(el.id);
          }
        });
        setSelectedElements(newSelectedElements);
      }
    } else if (isDrawing) {
      if (tool === 'pen') {
        setCurrentPath([...currentPath, point]);
      }
      // Store current mouse position for preview
      setCurrentPoint({ ...point, shiftKey: e.shiftKey });
    } else if (isErasing && tool === 'eraser') {
      // Add to eraser path for smooth erasing
      const lastPoint = eraserPath[eraserPath.length - 1];
      if (lastPoint) {
        // Interpolate points for smooth erasing
        const dist = Math.sqrt(
          Math.pow(point.x - lastPoint.x, 2) + 
          Math.pow(point.y - lastPoint.y, 2)
        );
        
        if (dist > 1) { // Process almost every movement for accuracy
          // Interpolate to ensure smooth continuous erasing
          // Use small steps to ensure we don't miss any area
          // Step size should be smaller than eraser radius to ensure full coverage
          const stepSize = Math.max(3, eraserSize / 4); // Larger erasers need proportional steps
          const steps = Math.min(20, Math.max(1, Math.ceil(dist / stepSize))); // Cap at 20 to prevent lag
          
          for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const interpPoint = {
              x: lastPoint.x + (point.x - lastPoint.x) * t,
              y: lastPoint.y + (point.y - lastPoint.y) * t
            };
            processErasing(interpPoint, eraserSize, false);
          }
          
          setEraserPath(prev => {
            const newPath = [...prev, point];
            // Keep path reasonably sized
            if (newPath.length > 100) {
              return newPath.slice(-50); // Keep last 50 points
            }
            return newPath;
          });
        }
      } else {
        // First point
        setEraserPath([point]);
        processErasing(point, eraserSize, true);
      }
      setCurrentPoint({ ...point, shiftKey: e.shiftKey });
    } else if (tool === 'eraser') {
      // Update cursor position for eraser preview when not dragging
      setCurrentPoint({ ...point, shiftKey: e.shiftKey });
    }
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
      setIsDrawingConnection(false);

      // Use the snapped connection point if available (from magnet effect)
      let targetElement: WhiteboardElement | null = null;
      let targetPoint: 'top' | 'right' | 'bottom' | 'left' | null = null;

      if (hoveredConnectionElement && snappedConnectionPoint) {
        // Use the already snapped connection
        targetElement = elements.find(el => el.id === hoveredConnectionElement) || null;
        targetPoint = snappedConnectionPoint;
      } else {
        // Fallback: Check all elements except the starting element
        for (const el of elements) {
          if (el.id === connectionStart.elementId) continue;
          if (el.type === 'arrow' || el.type === 'path') continue;

          const points = getConnectionPoints(el);
          if (!points) continue;

          const connectionPointRadius = 15; // Detection radius

          for (const [pointName, pointPos] of Object.entries(points) as [('top' | 'right' | 'bottom' | 'left'), { x: number; y: number }][]) {
            const dist = Math.sqrt(Math.pow(point.x - pointPos.x, 2) + Math.pow(point.y - pointPos.y, 2));
            if (dist <= connectionPointRadius) {
              targetElement = el;
              targetPoint = pointName;
              break;
            }
          }
          if (targetElement) break;
        }
      }

      // Create the connected arrow
      if (targetElement && targetPoint) {
        const targetPoints = getConnectionPoints(targetElement);
        if (targetPoints) {
          const newArrow: WhiteboardElement = {
            id: Date.now().toString(),
            type: 'arrow',
            x: connectionStart.x,
            y: connectionStart.y,
            endX: targetPoints[targetPoint].x,
            endY: targetPoints[targetPoint].y,
            strokeColor: strokeColor,
            strokeWidth: 2,
            arrowType: 'arrow',
            startElementId: connectionStart.elementId,
            startConnectionPoint: connectionStart.point,
            endElementId: targetElement.id,
            endConnectionPoint: targetPoint,
          };
          setElements([...elements, newArrow]);
          setTimeout(addToHistory, 100);
        }
      } else if (connectionEndPoint) {
        // Create arrow to the free point (not connected to element)
        const newArrow: WhiteboardElement = {
          id: Date.now().toString(),
          type: 'arrow',
          x: connectionStart.x,
          y: connectionStart.y,
          endX: connectionEndPoint.x,
          endY: connectionEndPoint.y,
          strokeColor: strokeColor,
          strokeWidth: 2,
          arrowType: 'arrow',
          startElementId: connectionStart.elementId,
          startConnectionPoint: connectionStart.point,
        };
        setElements([...elements, newArrow]);
        setTimeout(addToHistory, 100);
      }

      setConnectionStart(null);
      setConnectionEndPoint(null);
      setHoveredConnectionElement(null);
      setSnappedConnectionPoint(null);
      return;
    }

    // Handle middle mouse button release
    if (e.button === 1 && isMiddleMouseDown) {
      setIsMiddleMouseDown(false);
      setIsPanning(false);
      return;
    }

    if (isDraggingElement) {
      // Broadcast the final positions of dragged elements
      if (selectedElements.size > 0) {
        selectedElements.forEach(id => {
          const el = elements.find(e => e.id === id);
          if (el) {
            broadcastElementUpdate(id, { x: el.x, y: el.y, endX: el.endX, endY: el.endY, points: el.points });
          }
        });
      } else if (selectedElement) {
        const el = elements.find(e => e.id === selectedElement);
        if (el) {
          broadcastElementUpdate(selectedElement, { x: el.x, y: el.y, endX: el.endX, endY: el.endY, points: el.points });
        }
      }
      setIsDraggingElement(false);
      setDragElementsStart(new Map()); // Clear multi-element drag state
      setTimeout(addToHistory, 100);
      return;
    }

    if (isResizing) {
      // Broadcast the final size of resized element
      if (selectedElement) {
        const el = elements.find(e => e.id === selectedElement);
        if (el) {
          broadcastElementUpdate(selectedElement, {
            x: el.x, y: el.y,
            width: el.width, height: el.height,
            radiusX: el.radiusX, radiusY: el.radiusY,
            endX: el.endX, endY: el.endY
          });
        }
      }
      setIsResizing(false);
      setResizeHandle(null);
      setTimeout(addToHistory, 100);
      return;
    }

    if (isDraggingCornerRadius) {
      // Broadcast corner radius change
      if (selectedElement) {
        const el = elements.find(e => e.id === selectedElement);
        if (el) {
          broadcastElementUpdate(selectedElement, { borderRadius: el.borderRadius });
        }
      }
      setIsDraggingCornerRadius(null);
      setCornerRadiusDragStart(null);
      setTimeout(addToHistory, 100);
      return;
    }

    if (isSelecting && tool === 'select') {
      setIsSelecting(false);
      // Keep the selected elements
      if (selectedElements.size === 1) {
        // If only one element selected, set it as the single selected element
        setSelectedElement(Array.from(selectedElements)[0]);
        setSelectedElements(new Set());
      }
      setSelectionBox(null);
    } else if (isDrawing) {
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
      } else if (tool === 'rectangle') {
        let width = Math.abs(point.x - startPoint.x);
        let height = Math.abs(point.y - startPoint.y);
        let x = Math.min(point.x, startPoint.x);
        let y = Math.min(point.y, startPoint.y);

        // If shift was held, make it a square
        if (e.shiftKey) {
          const size = Math.max(width, height);
          width = size;
          height = size;

          // Adjust position based on drag direction
          if (point.x < startPoint.x) {
            x = startPoint.x - size;
          }
          if (point.y < startPoint.y) {
            y = startPoint.y - size;
          }
        }

        // Only create rectangle if it has some size (not just a click)
        if (width > 5 || height > 5) {
          const newRect: WhiteboardElement = {
            id: Date.now().toString(),
            type: 'rectangle',
            x,
            y,
            width,
            height,
            color: fillMode === 'stroke' ? 'transparent' : selectedColor,
            strokeColor: fillMode === 'fill' ? 'transparent' : strokeColor,
            strokeWidth: strokeWidth
          };
          addElementWithBroadcast(newRect);
          setTimeout(addToHistory, 100);
          setTool('select');
        }
      } else if (tool === 'circle') {
        // Create ellipse from bounding box (start to end point)
        let width = Math.abs(point.x - startPoint.x);
        let height = Math.abs(point.y - startPoint.y);

        // If shift was held, make it a perfect circle
        if (e.shiftKey) {
          const size = Math.max(width, height);
          width = size;
          height = size;
        }

        const radiusX = width / 2;
        const radiusY = height / 2;

        // Calculate center based on drag direction
        let centerX, centerY;
        if (e.shiftKey) {
          // For perfect circle, adjust based on drag direction
          if (point.x < startPoint.x) {
            centerX = startPoint.x - width / 2;
          } else {
            centerX = startPoint.x + width / 2;
          }
          if (point.y < startPoint.y) {
            centerY = startPoint.y - height / 2;
          } else {
            centerY = startPoint.y + height / 2;
          }
        } else {
          centerX = Math.min(point.x, startPoint.x) + radiusX;
          centerY = Math.min(point.y, startPoint.y) + radiusY;
        }

        // Only create ellipse if it has some size
        if (radiusX > 5 || radiusY > 5) {
          const newCircle: WhiteboardElement = {
            id: Date.now().toString(),
            type: 'circle',
            x: centerX,
            y: centerY,
            radiusX,
            radiusY,
            color: fillMode === 'stroke' ? 'transparent' : selectedColor,
            strokeColor: fillMode === 'fill' ? 'transparent' : strokeColor,
            strokeWidth: strokeWidth
          };
          addElementWithBroadcast(newCircle);
          setTimeout(addToHistory, 100);
          setTool('select');
        }
      } else if (tool === 'arrow') {
        const length = Math.sqrt(
          Math.pow(point.x - startPoint.x, 2) + 
          Math.pow(point.y - startPoint.y, 2)
        );
        // Only create arrow if it has some length
        if (length > 5) {
          const newArrow: WhiteboardElement = {
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
          addElementWithBroadcast(newArrow);
          setTimeout(addToHistory, 100);
          setTool('select');
        }
      }
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
  }, [zoomLevels, clampPanPosition, isZooming]);

  // Touch state refs for mobile support
  const touchStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const lastTouchDistanceRef = useRef<number | null>(null);
  const lastTouchCenterRef = useRef<{ x: number; y: number } | null>(null);
  const isTouchPanningRef = useRef(false);
  const [isTouchActive, setIsTouchActive] = useState(false); // State to disable transitions during touch

  // Handle touch start - for mobile panning and pinch-to-zoom
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Only handle pure touch events
    if (!e.touches.length) return;

    // Prevent default to stop mouse event simulation on touch devices
    e.preventDefault();
    setIsTouchActive(true); // Disable transitions during touch

    if (e.touches.length === 1) {
      const touch = e.touches[0];
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
      } else {
        isTouchPanningRef.current = false;
        // Calculate canvas point and set start point for drawing
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const canvasX = (touch.clientX - rect.left - panPosition.x) / zoom;
          const canvasY = (touch.clientY - rect.top - panPosition.y) / zoom;
          const point = { x: canvasX, y: canvasY };
          setStartPoint(point);

          // Handle select tool - check if touching an element
          if (tool === 'select') {
            // Find element at touch position
            const touchedElement = [...elements].reverse().find(el => {
              switch (el.type) {
                case 'rectangle':
                case 'sticky':
                  return point.x >= el.x! && point.x <= el.x! + el.width! &&
                         point.y >= el.y! && point.y <= el.y! + el.height!;
                case 'circle': {
                  const rx = el.radiusX ?? el.radius ?? 50;
                  const ry = el.radiusY ?? el.radius ?? 50;
                  const normalizedDist = Math.pow(point.x - el.x, 2) / (rx * rx) + Math.pow(point.y - el.y, 2) / (ry * ry);
                  return normalizedDist <= 1;
                }
                case 'text': {
                  const textWidth = Math.max(100, (el.text?.length || 0) * (el.fontSize || 16) * 0.6);
                  const textHeight = (el.fontSize || 16) * 1.5;
                  return point.x >= el.x && point.x <= el.x + textWidth &&
                         point.y >= el.y - textHeight && point.y <= el.y;
                }
                case 'arrow': {
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
                  return distToLine <= 15; // Slightly larger touch target
                }
                case 'path': {
                  if (!el.points || el.points.length < 2) return false;
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
                    if (segDist <= 15) return true; // Slightly larger touch target
                  }
                  return false;
                }
                default:
                  return false;
              }
            });

            if (touchedElement) {
              // Select and start dragging the element
              setSelectedElement(touchedElement.id);
              setSelectedElements(new Set());
              setIsDraggingElement(true);
              setDragStartPos(point);
              setDragElementStart({
                x: touchedElement.x || 0,
                y: touchedElement.y || 0,
                endX: touchedElement.endX,
                endY: touchedElement.endY,
                points: touchedElement.points ? [...touchedElement.points] : undefined,
              });
            } else {
              // Touched empty space - deselect
              setSelectedElement(null);
              setSelectedElements(new Set());
            }
          } else if (tool === 'rectangle' || tool === 'circle' || tool === 'arrow') {
            // Start drawing/placing based on tool
            setIsDrawing(true);
            setSelectedElement(null);
            setSelectedElements(new Set());
          } else if (tool === 'pen') {
            setIsDrawing(true);
            setCurrentPath([{ x: canvasX, y: canvasY }]);
            setSelectedElement(null);
            setSelectedElements(new Set());
          }
        }
      }
    } else if (e.touches.length === 2) {
      // Two touches - prepare for pinch-to-zoom
      isTouchPanningRef.current = false;
      setIsDrawing(false); // Cancel any drawing in progress

      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      // Calculate initial distance between touches
      const distance = Math.sqrt(
        Math.pow(touch2.clientX - touch1.clientX, 2) +
        Math.pow(touch2.clientY - touch1.clientY, 2)
      );
      lastTouchDistanceRef.current = distance;

      // Calculate center point between touches
      lastTouchCenterRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };
    }
  }, [panPosition, tool, zoom, elements]);

  // Handle touch move - pan canvas, pinch-to-zoom, or drawing
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1 && touchStartRef.current) {
      e.preventDefault();
      const touch = e.touches[0];

      if (isTouchPanningRef.current) {
        // Pan mode - move the canvas
        const deltaX = touch.clientX - touchStartRef.current.x;
        const deltaY = touch.clientY - touchStartRef.current.y;

        const newX = touchStartRef.current.panX + deltaX;
        const newY = touchStartRef.current.panY + deltaY;
        const clamped = clampPanPosition(newX, newY, zoom);
        setPanPosition(clamped);
      } else {
        // Handle element dragging or drawing tools
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const canvasX = (touch.clientX - rect.left - panPosition.x) / zoom;
          const canvasY = (touch.clientY - rect.top - panPosition.y) / zoom;
          const point = { x: canvasX, y: canvasY };

          // Handle element dragging (select tool)
          if (isDraggingElement && selectedElement) {
            const deltaX = point.x - dragStartPos.x;
            const deltaY = point.y - dragStartPos.y;
            setElements(prev => prev.map(el => {
              if (el.id !== selectedElement) return el;
              const updates: Partial<WhiteboardElement> = {
                x: dragElementStart.x + deltaX,
                y: dragElementStart.y + deltaY,
              };
              if (el.type === 'arrow' && dragElementStart.endX !== undefined && dragElementStart.endY !== undefined) {
                updates.endX = dragElementStart.endX + deltaX;
                updates.endY = dragElementStart.endY + deltaY;
              }
              if (el.type === 'path' && dragElementStart.points) {
                updates.points = dragElementStart.points.map(p => ({ x: p.x + deltaX, y: p.y + deltaY }));
              }
              return { ...el, ...updates };
            }));
          } else if (tool === 'pen' && isDrawing) {
            // Pen drawing
            setCurrentPath(prev => [...prev, { x: canvasX, y: canvasY }]);
            setCurrentPoint({ x: canvasX, y: canvasY, shiftKey: false });
          } else if (isDrawing) {
            // Update current point for rectangle/circle/arrow preview
            setCurrentPoint({ x: canvasX, y: canvasY, shiftKey: false });
          }
        }
      }
    } else if (e.touches.length === 2 && lastTouchDistanceRef.current !== null) {
      // Two touches - pinch-to-zoom
      e.preventDefault();
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      // Calculate new distance
      const newDistance = Math.sqrt(
        Math.pow(touch2.clientX - touch1.clientX, 2) +
        Math.pow(touch2.clientY - touch1.clientY, 2)
      );

      // Calculate zoom delta
      const scale = newDistance / lastTouchDistanceRef.current;
      const newZoom = Math.min(Math.max(0.025, zoom * scale), 5);

      // Calculate center point between touches
      const centerX = (touch1.clientX + touch2.clientX) / 2;
      const centerY = (touch1.clientY + touch2.clientY) / 2;

      // Adjust pan position to zoom towards the center point
      if (lastTouchCenterRef.current) {
        const scaleRatio = newZoom / zoom;
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const canvasCenterX = centerX - rect.left;
          const canvasCenterY = centerY - rect.top;

          setPanPosition(prev => {
            const newX = canvasCenterX - (canvasCenterX - prev.x) * scaleRatio;
            const newY = canvasCenterY - (canvasCenterY - prev.y) * scaleRatio;
            return clampPanPosition(newX, newY, newZoom);
          });
        }
      }

      // Update zoom
      const nearestIndex = zoomLevels.reduce((prev, curr, index) => {
        return Math.abs(curr - newZoom) < Math.abs(zoomLevels[prev] - newZoom) ? index : prev;
      }, 0);
      setZoomIndex(nearestIndex);
      zoomRef.current = newZoom;
      setZoom(newZoom);

      // Update refs for next move
      lastTouchDistanceRef.current = newDistance;
      lastTouchCenterRef.current = { x: centerX, y: centerY };
    }
  }, [zoom, zoomLevels, clampPanPosition, panPosition, tool, isDrawing, isDraggingElement, selectedElement, dragStartPos, dragElementStart]);

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
        const touch = e.changedTouches[0];
        const rect = canvasRef.current?.getBoundingClientRect();

        if (touch && rect) {
          const endX = (touch.clientX - rect.left - panPosition.x) / zoom;
          const endY = (touch.clientY - rect.top - panPosition.y) / zoom;

          // Create element based on tool
          if (tool === 'rectangle') {
            const width = Math.abs(endX - startPoint.x);
            const height = Math.abs(endY - startPoint.y);
            if (width > 5 || height > 5) {
              const newRect: WhiteboardElement = {
                id: Date.now().toString(),
                type: 'rectangle',
                x: Math.min(startPoint.x, endX),
                y: Math.min(startPoint.y, endY),
                width,
                height,
                color: fillMode === 'stroke' ? 'transparent' : selectedColor,
                strokeColor: fillMode === 'fill' ? 'transparent' : strokeColor,
                strokeWidth: strokeWidth,
              };
              setElements(prev => [...prev, newRect]);
              addToHistory();
            }
          } else if (tool === 'circle') {
            const width = Math.abs(endX - startPoint.x);
            const height = Math.abs(endY - startPoint.y);
            const radiusX = width / 2;
            const radiusY = height / 2;
            if (radiusX > 5 || radiusY > 5) {
              const centerX = Math.min(startPoint.x, endX) + radiusX;
              const centerY = Math.min(startPoint.y, endY) + radiusY;
              const newCircle: WhiteboardElement = {
                id: Date.now().toString(),
                type: 'circle',
                x: centerX,
                y: centerY,
                radiusX,
                radiusY,
                color: fillMode === 'stroke' ? 'transparent' : selectedColor,
                strokeColor: fillMode === 'fill' ? 'transparent' : strokeColor,
                strokeWidth: strokeWidth,
              };
              setElements(prev => [...prev, newCircle]);
              addToHistory();
            }
          } else if (tool === 'arrow') {
            const length = Math.sqrt(Math.pow(endX - startPoint.x, 2) + Math.pow(endY - startPoint.y, 2));
            if (length > 5) {
              const newArrow: WhiteboardElement = {
                id: Date.now().toString(),
                type: 'arrow',
                x: startPoint.x,
                y: startPoint.y,
                endX: endX,
                endY: endY,
                strokeColor: strokeColor,
                strokeWidth: strokeWidth,
                arrowType: arrowType,
              };
              setElements(prev => [...prev, newArrow]);
              addToHistory();
            }
          } else if (tool === 'pen' && currentPath.length > 1) {
            const newPath: WhiteboardElement = {
              id: Date.now().toString(),
              type: 'path',
              x: 0,
              y: 0,
              points: currentPath,
              strokeColor: strokeColor,
              strokeWidth: strokeWidth,
            };
            setElements(prev => [...prev, newPath]);
            addToHistory();
          }
        }
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
  }, [panPosition, zoom, tool, isDrawing, isDraggingElement, startPoint, currentPath, fillMode, selectedColor, strokeColor, strokeWidth, arrowType, addToHistory]);

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
          const ctxRx = el.radiusX ?? el.radius ?? 50;
          const ctxRy = el.radiusY ?? el.radius ?? 50;
          // Ellipse equation check
          const ctxNormDist = Math.pow(point.x - el.x, 2) / (ctxRx * ctxRx) + Math.pow(point.y - el.y, 2) / (ctxRy * ctxRy);
          return ctxNormDist <= 1;
        case 'text':
          const textWidth = Math.max(100, (el.text?.length || 0) * (el.fontSize || 16) * 0.6);
          const textHeight = (el.fontSize || 16) * 1.5;
          return point.x >= el.x && point.x <= el.x + textWidth &&
                 point.y >= el.y - textHeight && point.y <= el.y;
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
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        elementId: clickedElement.id
      });
    } else {
      setContextMenu(null);
    }
  }, [elements, screenToCanvas, zoom]);

  // Context menu actions
  const bringToFront = useCallback(() => {
    if (!contextMenu) return;
    const elementIndex = elements.findIndex(el => el.id === contextMenu.elementId);
    if (elementIndex === -1) return;
    const element = elements[elementIndex];
    const newElements = [...elements];
    newElements.splice(elementIndex, 1);
    newElements.push(element);
    setElements(newElements);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [contextMenu, elements, addToHistory]);

  const sendToBack = useCallback(() => {
    if (!contextMenu) return;
    const elementIndex = elements.findIndex(el => el.id === contextMenu.elementId);
    if (elementIndex === -1) return;
    const element = elements[elementIndex];
    const newElements = [...elements];
    newElements.splice(elementIndex, 1);
    newElements.unshift(element);
    setElements(newElements);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [contextMenu, elements, addToHistory]);

  const bringForward = useCallback(() => {
    if (!contextMenu) return;
    const elementIndex = elements.findIndex(el => el.id === contextMenu.elementId);
    if (elementIndex === -1 || elementIndex === elements.length - 1) return;
    const newElements = [...elements];
    [newElements[elementIndex], newElements[elementIndex + 1]] = [newElements[elementIndex + 1], newElements[elementIndex]];
    setElements(newElements);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [contextMenu, elements, addToHistory]);

  const sendBackward = useCallback(() => {
    if (!contextMenu) return;
    const elementIndex = elements.findIndex(el => el.id === contextMenu.elementId);
    if (elementIndex <= 0) return;
    const newElements = [...elements];
    [newElements[elementIndex], newElements[elementIndex - 1]] = [newElements[elementIndex - 1], newElements[elementIndex]];
    setElements(newElements);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [contextMenu, elements, addToHistory]);

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
    if (clipboard.length === 0) return;

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
  }, [clipboard, elements, addToHistory]);

  const duplicateElement = useCallback(() => {
    if (!contextMenu) return;
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
  }, [contextMenu, elements, addToHistory]);

  const deleteElement = useCallback(() => {
    if (!contextMenu) return;
    deleteElementWithBroadcast(contextMenu.elementId);
    setSelectedElement(null);
    setTimeout(addToHistory, 100);
    setContextMenu(null);
  }, [contextMenu, deleteElementWithBroadcast, addToHistory]);

  // Close context menu when clicking elsewhere
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      window.addEventListener('click', handleClick);
      return () => window.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  // Keyboard shortcuts for copy, paste, delete, duplicate
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when editing text
      if (editingElement) return;

      // Don't trigger shortcuts when typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

      // Copy: Cmd/Ctrl + C
      if (cmdOrCtrl && e.key === 'c') {
        if (selectedElement || selectedElements.size > 0) {
          e.preventDefault();
          copyElement();
        }
      }

      // Paste: Cmd/Ctrl + V
      if (cmdOrCtrl && e.key === 'v') {
        if (clipboard.length > 0) {
          e.preventDefault();
          pasteElement();
        }
      }

      // Duplicate: Cmd/Ctrl + D
      if (cmdOrCtrl && e.key === 'd') {
        if (selectedElements.size > 0) {
          // Duplicate multiple selected elements
          e.preventDefault();
          const elementsToDuplicate = elements.filter(el => selectedElements.has(el.id));
          const newElements: WhiteboardElement[] = elementsToDuplicate.map((el, index) => ({
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
          setSelectedElement(null);
          setSelectedElements(new Set(newElements.map(el => el.id)));
          setTimeout(addToHistory, 100);
        } else if (selectedElement) {
          // Duplicate single selected element
          e.preventDefault();
          const element = elements.find(el => el.id === selectedElement);
          if (element) {
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
          }
        }
      }

      // Delete: Backspace or Delete
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedElement || selectedElements.size > 0) {
          e.preventDefault();
          deleteSelectedElement();
        }
      }

      // Bring to front: Cmd/Ctrl + ]
      if (cmdOrCtrl && e.key === ']') {
        if (selectedElement) {
          e.preventDefault();
          const elementIndex = elements.findIndex(el => el.id === selectedElement);
          if (elementIndex !== -1 && elementIndex !== elements.length - 1) {
            const element = elements[elementIndex];
            const newElements = [...elements];
            newElements.splice(elementIndex, 1);
            newElements.push(element);
            setElements(newElements);
            setTimeout(addToHistory, 100);
          }
        }
      }

      // Send to back: Cmd/Ctrl + [
      if (cmdOrCtrl && e.key === '[') {
        if (selectedElement) {
          e.preventDefault();
          const elementIndex = elements.findIndex(el => el.id === selectedElement);
          if (elementIndex > 0) {
            const element = elements[elementIndex];
            const newElements = [...elements];
            newElements.splice(elementIndex, 1);
            newElements.unshift(element);
            setElements(newElements);
            setTimeout(addToHistory, 100);
          }
        }
      }

      // Select all: Cmd/Ctrl + A
      if (cmdOrCtrl && e.key === 'a') {
        e.preventDefault();
        const allIds = new Set(elements.map(el => el.id));
        setSelectedElements(allIds);
        setSelectedElement(null);
      }

      // Escape: Deselect all and reset tool to select
      if (e.key === 'Escape') {
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedElement, selectedElements, clipboard, elements, editingElement, copyElement, pasteElement, addToHistory]);

  // Delete selected element(s)
  const deleteSelectedElement = () => {
    if (selectedElements.size > 0) {
      // Delete multiple elements and broadcast
      selectedElements.forEach(id => {
        if (isConnected) {
          broadcastElementDelete(id);
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
  };

  // Cleanup eraser paths periodically for performance
  useEffect(() => {
    const interval = setInterval(() => {
      setElements(prev => prev.map(element => {
        if (element.erasedPaths && element.erasedPaths.length > 0) {
          // Consolidate and simplify erased paths
          const totalPoints = element.erasedPaths.reduce((sum, stroke) => sum + stroke.points.length, 0);
          if (totalPoints > 500) {
            // Too many points, merge and simplify aggressively
            const allPoints = element.erasedPaths.flatMap(s => s.points);
            const avgSize = element.erasedPaths.reduce((sum, s) => sum + s.size, 0) / element.erasedPaths.length;
            const simplified = simplifyPath(allPoints);
            return {
              ...element,
              erasedPaths: [{
                points: simplified,
                size: avgSize
              }]
            };
          }
        }
        return element;
      }));
    }, 5000); // Run every 5 seconds

    return () => clearInterval(interval);
  }, []);

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

      // Undo/Redo shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
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
      
      // Zoom shortcuts - snap to discrete zoom levels
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        
        // Use the tracked index directly
        if (zoomIndex < zoomLevels.length - 1) {
          const newIndex = zoomIndex + 1;
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
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();

        // Use the tracked index directly
        if (zoomIndex > 0) {
          const newIndex = zoomIndex - 1;
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
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        zoomRef.current = 1;
        setZoom(1);
        setZoomIndex(8); // Index 8 = 100%
        // Center canvas origin in viewport
        const { width: vw, height: vh } = viewportSizeRef.current;
        setPanPosition({ x: vw / 2, y: vh / 2 });
      }
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
  }, [selectedElement, elements, undo, redo, zoom, zoomIndex, zoomLevels, editingElement]);

  // Render element with eraser mask
  const renderElement = (element: WhiteboardElement) => {
    const maskId = `mask-${element.id}`;
    const needsMask = element.erasedPaths && element.erasedPaths.length > 0;
    
    const elementContent = () => {
    switch (element.type) {
      case 'rectangle':
        return (
          <>
            <rect
              x={element.x}
              y={element.y}
              width={element.width}
              height={element.height}
              rx={element.borderRadius || 0}
              ry={element.borderRadius || 0}
              fill={element.color === 'transparent' ? 'none' : displayColor(element.color)}
              stroke={element.strokeColor === 'transparent' ? 'none' : displayColor(element.strokeColor)}
              strokeWidth={element.strokeWidth || strokeWidth}
              className="cursor-pointer"
              onClick={() => {
                setSelectedElement(element.id);
                setSelectedElements(new Set());
              }}
            />
            {/* Selection border for single selection */}
            {selectedElement === element.id && (
              <>
                <rect
                  x={element.x}
                  y={element.y}
                  width={element.width || 0}
                  height={element.height || 0}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  rx={element.borderRadius || 2}
                  ry={element.borderRadius || 2}
                  pointerEvents="none"
                />
                {/* Resize handles */}
                {/* Top-left handle */}
                <circle
                  cx={element.x}
                  cy={element.y}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-nw-resize"
                  style={{ pointerEvents: 'all' }}
                  data-handle="nw"
                />
                {/* Top-right handle */}
                <circle
                  cx={element.x! + (element.width || 0)}
                  cy={element.y}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-ne-resize"
                  style={{ pointerEvents: 'all' }}
                  data-handle="ne"
                />
                {/* Bottom-left handle */}
                <circle
                  cx={element.x}
                  cy={element.y! + (element.height || 0)}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-sw-resize"
                  style={{ pointerEvents: 'all' }}
                  data-handle="sw"
                />
                {/* Bottom-right handle */}
                <circle
                  cx={element.x! + (element.width || 0)}
                  cy={element.y! + (element.height || 0)}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-se-resize"
                  style={{ pointerEvents: 'all' }}
                  data-handle="se"
                />
                {/* Corner radius handles - inside corners */}
                {(() => {
                  const radius = element.borderRadius || 0;
                  const offset = Math.max(12, radius + 6); // Position based on current radius
                  const handleSize = 5;
                  return (
                    <>
                      {/* Top-left corner radius handle */}
                      <circle
                        cx={element.x! + offset}
                        cy={element.y! + offset}
                        r={handleSize}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-pointer"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDraggingCornerRadius('tl');
                          const point = screenToCanvas(e.clientX, e.clientY);
                          setCornerRadiusDragStart({ x: point.x, y: point.y, initialRadius: radius });
                        }}
                      />
                      {/* Top-right corner radius handle */}
                      <circle
                        cx={element.x! + (element.width || 0) - offset}
                        cy={element.y! + offset}
                        r={handleSize}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-pointer"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDraggingCornerRadius('tr');
                          const point = screenToCanvas(e.clientX, e.clientY);
                          setCornerRadiusDragStart({ x: point.x, y: point.y, initialRadius: radius });
                        }}
                      />
                      {/* Bottom-left corner radius handle */}
                      <circle
                        cx={element.x! + offset}
                        cy={element.y! + (element.height || 0) - offset}
                        r={handleSize}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-pointer"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDraggingCornerRadius('bl');
                          const point = screenToCanvas(e.clientX, e.clientY);
                          setCornerRadiusDragStart({ x: point.x, y: point.y, initialRadius: radius });
                        }}
                      />
                      {/* Bottom-right corner radius handle */}
                      <circle
                        cx={element.x! + (element.width || 0) - offset}
                        cy={element.y! + (element.height || 0) - offset}
                        r={handleSize}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-pointer"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDraggingCornerRadius('br');
                          const point = screenToCanvas(e.clientX, e.clientY);
                          setCornerRadiusDragStart({ x: point.x, y: point.y, initialRadius: radius });
                        }}
                      />
                    </>
                  );
                })()}
                {/* Connection points */}
                {(() => {
                  const points = getConnectionPoints(element);
                  if (!points) return null;
                  return (
                    <>
                      {/* Top connection point */}
                      <circle
                        cx={points.top.x}
                        cy={points.top.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'top', x: points.top.x, y: points.top.y });
                          setConnectionEndPoint(points.top);
                        }}
                      />
                      {/* Right connection point */}
                      <circle
                        cx={points.right.x}
                        cy={points.right.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'right', x: points.right.x, y: points.right.y });
                          setConnectionEndPoint(points.right);
                        }}
                      />
                      {/* Bottom connection point */}
                      <circle
                        cx={points.bottom.x}
                        cy={points.bottom.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'bottom', x: points.bottom.x, y: points.bottom.y });
                          setConnectionEndPoint(points.bottom);
                        }}
                      />
                      {/* Left connection point */}
                      <circle
                        cx={points.left.x}
                        cy={points.left.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'left', x: points.left.x, y: points.left.y });
                          setConnectionEndPoint(points.left);
                        }}
                      />
                    </>
                  );
                })()}
              </>
            )}
            {/* Connection points shown when hovering during connection drawing */}
            {isDrawingConnection && hoveredConnectionElement === element.id && (
              (() => {
                const points = getConnectionPoints(element);
                if (!points) return null;
                return (
                  <>
                    {/* Top connection point */}
                    <circle
                      cx={points.top.x}
                      cy={points.top.y}
                      r={snappedConnectionPoint === 'top' ? 10 : 6}
                      fill={snappedConnectionPoint === 'top' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Right connection point */}
                    <circle
                      cx={points.right.x}
                      cy={points.right.y}
                      r={snappedConnectionPoint === 'right' ? 10 : 6}
                      fill={snappedConnectionPoint === 'right' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Bottom connection point */}
                    <circle
                      cx={points.bottom.x}
                      cy={points.bottom.y}
                      r={snappedConnectionPoint === 'bottom' ? 10 : 6}
                      fill={snappedConnectionPoint === 'bottom' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Left connection point */}
                    <circle
                      cx={points.left.x}
                      cy={points.left.y}
                      r={snappedConnectionPoint === 'left' ? 10 : 6}
                      fill={snappedConnectionPoint === 'left' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                  </>
                );
              })()
            )}
          </>
        );

      case 'circle':
        // Support both legacy radius and new radiusX/radiusY for ellipses
        const ellipseRx = element.radiusX ?? element.radius ?? 50;
        const ellipseRy = element.radiusY ?? element.radius ?? 50;
        return (
          <>
            <ellipse
              cx={element.x}
              cy={element.y}
              rx={ellipseRx}
              ry={ellipseRy}
              fill={element.color === 'transparent' ? 'none' : displayColor(element.color)}
              stroke={element.strokeColor === 'transparent' ? 'none' : displayColor(element.strokeColor)}
              strokeWidth={element.strokeWidth || strokeWidth}
              className="cursor-pointer"
              onClick={() => {
                setSelectedElement(element.id);
                setSelectedElements(new Set());
              }}
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
                {/* Top-left handle */}
                <circle
                  cx={element.x - ellipseRx}
                  cy={element.y - ellipseRy}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-nw-resize"
                  style={{ pointerEvents: 'all' }}
                  data-handle="nw"
                />
                {/* Top-right handle */}
                <circle
                  cx={element.x + ellipseRx}
                  cy={element.y - ellipseRy}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-ne-resize"
                  style={{ pointerEvents: 'all' }}
                  data-handle="ne"
                />
                {/* Bottom-left handle */}
                <circle
                  cx={element.x - ellipseRx}
                  cy={element.y + ellipseRy}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-sw-resize"
                  style={{ pointerEvents: 'all' }}
                  data-handle="sw"
                />
                {/* Bottom-right handle */}
                <circle
                  cx={element.x + ellipseRx}
                  cy={element.y + ellipseRy}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-se-resize"
                  style={{ pointerEvents: 'all' }}
                  data-handle="se"
                />
                {/* Connection points */}
                {(() => {
                  const points = getConnectionPoints(element);
                  if (!points) return null;
                  return (
                    <>
                      {/* Top connection point */}
                      <circle
                        cx={points.top.x}
                        cy={points.top.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'top', x: points.top.x, y: points.top.y });
                          setConnectionEndPoint(points.top);
                        }}
                      />
                      {/* Right connection point */}
                      <circle
                        cx={points.right.x}
                        cy={points.right.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'right', x: points.right.x, y: points.right.y });
                          setConnectionEndPoint(points.right);
                        }}
                      />
                      {/* Bottom connection point */}
                      <circle
                        cx={points.bottom.x}
                        cy={points.bottom.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'bottom', x: points.bottom.x, y: points.bottom.y });
                          setConnectionEndPoint(points.bottom);
                        }}
                      />
                      {/* Left connection point */}
                      <circle
                        cx={points.left.x}
                        cy={points.left.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'left', x: points.left.x, y: points.left.y });
                          setConnectionEndPoint(points.left);
                        }}
                      />
                    </>
                  );
                })()}
              </>
            )}
            {/* Connection points shown when hovering during connection drawing */}
            {isDrawingConnection && hoveredConnectionElement === element.id && (
              (() => {
                const points = getConnectionPoints(element);
                if (!points) return null;
                return (
                  <>
                    {/* Top connection point */}
                    <circle
                      cx={points.top.x}
                      cy={points.top.y}
                      r={snappedConnectionPoint === 'top' ? 10 : 6}
                      fill={snappedConnectionPoint === 'top' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Right connection point */}
                    <circle
                      cx={points.right.x}
                      cy={points.right.y}
                      r={snappedConnectionPoint === 'right' ? 10 : 6}
                      fill={snappedConnectionPoint === 'right' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Bottom connection point */}
                    <circle
                      cx={points.bottom.x}
                      cy={points.bottom.y}
                      r={snappedConnectionPoint === 'bottom' ? 10 : 6}
                      fill={snappedConnectionPoint === 'bottom' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Left connection point */}
                    <circle
                      cx={points.left.x}
                      cy={points.left.y}
                      r={snappedConnectionPoint === 'left' ? 10 : 6}
                      fill={snappedConnectionPoint === 'left' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                  </>
                );
              })()
            )}
          </>
        );

      case 'text':
        const isTextEditing = editingElement === element.id;
        const textFontSize = element.fontSize || 16;
        const textElementLines = (element.text || '').split('\n');
        const maxLineLength = Math.max(...textElementLines.map(line => line.length), 1);
        const estimatedTextWidth = Math.max(200, maxLineLength * textFontSize * 0.7 + 40);
        const textAreaHeight = Math.max(textFontSize * 2, textElementLines.length * textFontSize * 1.5 + 20);

        return (
          <g>
            {isTextEditing ? (
              <foreignObject
                x={element.x}
                y={element.y - textFontSize}
                width={estimatedTextWidth}
                height={textAreaHeight}
                style={{ pointerEvents: 'auto', overflow: 'visible' }}
              >
                <textarea
                  ref={(textarea) => {
                    if (textarea && document.activeElement !== textarea) {
                      // Use setTimeout to ensure React has finished rendering
                      setTimeout(() => {
                        textarea.focus();
                        // Move cursor to end of text
                        const len = textarea.value?.length || 0;
                        textarea.setSelectionRange(len, len);
                      }, 0);
                    }
                  }}
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
                  onChange={(e) => {
                    const updated = elements.map(el =>
                      el.id === element.id ? { ...el, text: e.target.value } : el
                    );
                    setElements(updated);
                  }}
                  onBlur={(e) => {
                    // Don't close if clicking within the toolbar
                    const relatedTarget = e.relatedTarget as HTMLElement;
                    if (relatedTarget?.closest('.fixed.z-50')) {
                      return;
                    }
                    // Remove text element if empty (check the actual textarea value)
                    const textValue = (e.target as HTMLTextAreaElement).value;
                    if (!textValue || textValue.trim() === '') {
                      deleteElementWithBroadcast(element.id);
                      setSelectedElement(null);
                    } else {
                      // Broadcast text change
                      broadcastElementUpdate(element.id, { text: textValue });
                    }
                    setEditingElement(null);
                    setTimeout(addToHistory, 100);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                      // Remove text element if empty when pressing Escape
                      const textValue = (e.target as HTMLTextAreaElement).value;
                      if (!textValue || textValue.trim() === '') {
                        setElements(prev => prev.filter(el => el.id !== element.id));
                        setSelectedElement(null);
                      }
                      setEditingElement(null);
                    }
                  }}
                />
              </foreignObject>
            ) : (
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
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (element.link && e.ctrlKey) {
                      window.open(element.link, '_blank');
                      return;
                    }
                    const point = screenToCanvas(e.clientX, e.clientY);
                    setSelectedElement(element.id);
                    setSelectedElements(new Set());
                    setIsDraggingElement(true);
                    setDragStartPos(point);
                    setDragElementStart({ x: element.x || 0, y: element.y || 0 });
                  }}
                  onDoubleClick={() => {
                    setEditingElement(element.id);
                  }}
                  ref={(node) => {
                    if (node) {
                      // Get the text element's bounding box to size the hit area
                      const textEl = node.parentElement?.querySelector('text');
                      if (textEl) {
                        const bbox = textEl.getBBox();
                        node.setAttribute('x', String(bbox.x - 6));
                        node.setAttribute('y', String(bbox.y - 4));
                        node.setAttribute('width', String(bbox.width + 12));
                        node.setAttribute('height', String(bbox.height + 8));

                        // Also update selection rect if present (for single or multi selection)
                        const selRect = node.parentElement?.querySelector('.selection-rect') as SVGRectElement;
                        if (selRect) {
                          selRect.setAttribute('x', String(bbox.x - 6));
                          selRect.setAttribute('y', String(bbox.y - 4));
                          selRect.setAttribute('width', String(bbox.width + 12));
                          selRect.setAttribute('height', String(bbox.height + 8));
                        }

                        // Store bounding box in ref for arrow connection positioning
                        const existingBbox = textBoundingBoxesRef.current.get(element.id);
                        const bboxChanged = !existingBbox ||
                          existingBbox.x !== bbox.x ||
                          existingBbox.y !== bbox.y ||
                          existingBbox.width !== bbox.width ||
                          existingBbox.height !== bbox.height;

                        if (bboxChanged) {
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
                        const connPoints = node.parentElement?.querySelectorAll('.text-connection-point');
                        if (connPoints && connPoints.length === 4) {
                          const centerX = bbox.x + bbox.width / 2;
                          const centerY = bbox.y + bbox.height / 2;
                          // Top
                          connPoints[0].setAttribute('cx', String(centerX));
                          connPoints[0].setAttribute('cy', String(bbox.y - 4));
                          // Right
                          connPoints[1].setAttribute('cx', String(bbox.x + bbox.width + 6));
                          connPoints[1].setAttribute('cy', String(centerY));
                          // Bottom
                          connPoints[2].setAttribute('cx', String(centerX));
                          connPoints[2].setAttribute('cy', String(bbox.y + bbox.height + 4));
                          // Left
                          connPoints[3].setAttribute('cx', String(bbox.x - 6));
                          connPoints[3].setAttribute('cy', String(centerY));
                        }

                        // Store bounding box for toolbar positioning (only for single selection to avoid infinite loop)
                        if (selectedElement === element.id && !selectedElements.has(element.id)) {
                          if (!textBoundingBox ||
                              textBoundingBox.x !== bbox.x ||
                              textBoundingBox.y !== bbox.y ||
                              textBoundingBox.width !== bbox.width ||
                              textBoundingBox.height !== bbox.height) {
                            setTextBoundingBox({ x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height });
                          }
                        }
                      }
                    }
                  }}
                />
                <text
                  x={element.x}
                  y={element.y}
                  fill={element.text ? displayColor(element.color) : '#9ca3af'}
                  fontSize={textFontSize}
                  fontWeight={element.fontWeight || 'normal'}
                  fontStyle={element.text ? (element.fontStyle || 'normal') : 'italic'}
                  textDecoration={element.textDecoration || 'none'}
                  textAnchor={element.textAlign === 'center' ? 'middle' : element.textAlign === 'right' ? 'end' : 'start'}
                  className="pointer-events-none select-none"
                  style={element.link ? { textDecoration: 'underline' } : {}}
                >
                  {(element.text || 'Type something...').split('\n').map((line, index) => (
                    <tspan
                      key={index}
                      x={element.x}
                      dy={index === 0 ? 0 : textFontSize * 1.5}
                    >
                      {line || ' '}
                    </tspan>
                  ))}
                </text>
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
                {selectedElement === element.id && !isTextEditing && (
                  (() => {
                    const points = getConnectionPoints(element);
                    if (!points) return null;
                    return (
                      <>
                        {/* Top connection point */}
                        <circle
                          cx={points.top.x}
                          cy={points.top.y}
                          r={5}
                          fill="#3b82f6"
                          stroke="white"
                          strokeWidth={2}
                          className="cursor-crosshair text-connection-point"
                          style={{ pointerEvents: 'all' }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const circle = e.currentTarget;
                            const cx = parseFloat(circle.getAttribute('cx') || '0');
                            const cy = parseFloat(circle.getAttribute('cy') || '0');
                            setIsDrawingConnection(true);
                            setConnectionStart({ elementId: element.id, point: 'top', x: cx, y: cy });
                            setConnectionEndPoint({ x: cx, y: cy });
                          }}
                        />
                        {/* Right connection point */}
                        <circle
                          cx={points.right.x}
                          cy={points.right.y}
                          r={5}
                          fill="#3b82f6"
                          stroke="white"
                          strokeWidth={2}
                          className="cursor-crosshair text-connection-point"
                          style={{ pointerEvents: 'all' }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const circle = e.currentTarget;
                            const cx = parseFloat(circle.getAttribute('cx') || '0');
                            const cy = parseFloat(circle.getAttribute('cy') || '0');
                            setIsDrawingConnection(true);
                            setConnectionStart({ elementId: element.id, point: 'right', x: cx, y: cy });
                            setConnectionEndPoint({ x: cx, y: cy });
                          }}
                        />
                        {/* Bottom connection point */}
                        <circle
                          cx={points.bottom.x}
                          cy={points.bottom.y}
                          r={5}
                          fill="#3b82f6"
                          stroke="white"
                          strokeWidth={2}
                          className="cursor-crosshair text-connection-point"
                          style={{ pointerEvents: 'all' }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const circle = e.currentTarget;
                            const cx = parseFloat(circle.getAttribute('cx') || '0');
                            const cy = parseFloat(circle.getAttribute('cy') || '0');
                            setIsDrawingConnection(true);
                            setConnectionStart({ elementId: element.id, point: 'bottom', x: cx, y: cy });
                            setConnectionEndPoint({ x: cx, y: cy });
                          }}
                        />
                        {/* Left connection point */}
                        <circle
                          cx={points.left.x}
                          cy={points.left.y}
                          r={5}
                          fill="#3b82f6"
                          stroke="white"
                          strokeWidth={2}
                          className="cursor-crosshair text-connection-point"
                          style={{ pointerEvents: 'all' }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const circle = e.currentTarget;
                            const cx = parseFloat(circle.getAttribute('cx') || '0');
                            const cy = parseFloat(circle.getAttribute('cy') || '0');
                            setIsDrawingConnection(true);
                            setConnectionStart({ elementId: element.id, point: 'left', x: cx, y: cy });
                            setConnectionEndPoint({ x: cx, y: cy });
                          }}
                        />
                      </>
                    );
                  })()
                )}
                {/* Connection points shown when hovering during connection drawing */}
                {isDrawingConnection && hoveredConnectionElement === element.id && (
                  (() => {
                    const points = getConnectionPoints(element);
                    if (!points) return null;
                    return (
                      <>
                        {/* Top connection point */}
                        <circle
                          cx={points.top.x}
                          cy={points.top.y}
                          r={snappedConnectionPoint === 'top' ? 10 : 6}
                          fill={snappedConnectionPoint === 'top' ? '#22c55e' : '#3b82f6'}
                          stroke="white"
                          strokeWidth={2}
                          className="cursor-crosshair"
                          style={{ pointerEvents: 'none' }}
                        />
                        {/* Right connection point */}
                        <circle
                          cx={points.right.x}
                          cy={points.right.y}
                          r={snappedConnectionPoint === 'right' ? 10 : 6}
                          fill={snappedConnectionPoint === 'right' ? '#22c55e' : '#3b82f6'}
                          stroke="white"
                          strokeWidth={2}
                          className="cursor-crosshair"
                          style={{ pointerEvents: 'none' }}
                        />
                        {/* Bottom connection point */}
                        <circle
                          cx={points.bottom.x}
                          cy={points.bottom.y}
                          r={snappedConnectionPoint === 'bottom' ? 10 : 6}
                          fill={snappedConnectionPoint === 'bottom' ? '#22c55e' : '#3b82f6'}
                          stroke="white"
                          strokeWidth={2}
                          className="cursor-crosshair"
                          style={{ pointerEvents: 'none' }}
                        />
                        {/* Left connection point */}
                        <circle
                          cx={points.left.x}
                          cy={points.left.y}
                          r={snappedConnectionPoint === 'left' ? 10 : 6}
                          fill={snappedConnectionPoint === 'left' ? '#22c55e' : '#3b82f6'}
                          stroke="white"
                          strokeWidth={2}
                          className="cursor-crosshair"
                          style={{ pointerEvents: 'none' }}
                        />
                      </>
                    );
                  })()
                )}
              </>
            )}
          </g>
        );

      case 'sticky':
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
              onClick={() => {
                setSelectedElement(element.id);
                setSelectedElements(new Set());
              }}
              onDoubleClick={() => {
                setEditingElement(element.id);
              }}
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
                    ref={(textarea) => {
                      if (textarea && document.activeElement !== textarea) {
                        // Use setTimeout to ensure React has finished rendering
                        setTimeout(() => {
                          textarea.focus();
                          // Move cursor to end of text
                          const len = textarea.value?.length || 0;
                          textarea.setSelectionRange(len, len);
                        }, 0);
                      }
                    }}
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
                    onChange={(e) => {
                      const updated = elements.map(el =>
                        el.id === element.id ? { ...el, text: e.target.value } : el
                      );
                      setElements(updated);
                    }}
                    onBlur={(e) => {
                      // Broadcast text change
                      broadcastElementUpdate(element.id, { text: (e.target as HTMLTextAreaElement).value });
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
                {/* Top-left handle */}
                <circle
                  cx={element.x}
                  cy={element.y}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-nw-resize"
                  style={{ pointerEvents: 'all' }}
                />
                {/* Top-right handle */}
                <circle
                  cx={element.x! + element.width!}
                  cy={element.y}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-ne-resize"
                  style={{ pointerEvents: 'all' }}
                />
                {/* Bottom-left handle */}
                <circle
                  cx={element.x}
                  cy={element.y! + stickyHeight}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-sw-resize"
                  style={{ pointerEvents: 'all' }}
                />
                {/* Bottom-right handle */}
                <circle
                  cx={element.x! + element.width!}
                  cy={element.y! + stickyHeight}
                  r={6}
                  fill="white"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  className="cursor-se-resize"
                  style={{ pointerEvents: 'all' }}
                />
                {/* Connection points for sticky notes */}
                {(() => {
                  const points = getConnectionPoints(element);
                  if (!points) return null;
                  return (
                    <>
                      {/* Top connection point */}
                      <circle
                        cx={points.top.x}
                        cy={points.top.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'top', x: points.top.x, y: points.top.y });
                          setConnectionEndPoint(points.top);
                        }}
                      />
                      {/* Right connection point */}
                      <circle
                        cx={points.right.x}
                        cy={points.right.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'right', x: points.right.x, y: points.right.y });
                          setConnectionEndPoint(points.right);
                        }}
                      />
                      {/* Bottom connection point */}
                      <circle
                        cx={points.bottom.x}
                        cy={points.bottom.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'bottom', x: points.bottom.x, y: points.bottom.y });
                          setConnectionEndPoint(points.bottom);
                        }}
                      />
                      {/* Left connection point */}
                      <circle
                        cx={points.left.x}
                        cy={points.left.y}
                        r={5}
                        fill="#3b82f6"
                        stroke="white"
                        strokeWidth={2}
                        className="cursor-crosshair"
                        style={{ pointerEvents: 'all' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setIsDrawingConnection(true);
                          setConnectionStart({ elementId: element.id, point: 'left', x: points.left.x, y: points.left.y });
                          setConnectionEndPoint(points.left);
                        }}
                      />
                    </>
                  );
                })()}
              </>
            )}
            {/* Connection points shown when hovering during connection drawing */}
            {isDrawingConnection && hoveredConnectionElement === element.id && (
              (() => {
                const points = getConnectionPoints(element);
                if (!points) return null;
                return (
                  <>
                    {/* Top connection point */}
                    <circle
                      cx={points.top.x}
                      cy={points.top.y}
                      r={snappedConnectionPoint === 'top' ? 10 : 6}
                      fill={snappedConnectionPoint === 'top' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Right connection point */}
                    <circle
                      cx={points.right.x}
                      cy={points.right.y}
                      r={snappedConnectionPoint === 'right' ? 10 : 6}
                      fill={snappedConnectionPoint === 'right' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Bottom connection point */}
                    <circle
                      cx={points.bottom.x}
                      cy={points.bottom.y}
                      r={snappedConnectionPoint === 'bottom' ? 10 : 6}
                      fill={snappedConnectionPoint === 'bottom' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* Left connection point */}
                    <circle
                      cx={points.left.x}
                      cy={points.left.y}
                      r={snappedConnectionPoint === 'left' ? 10 : 6}
                      fill={snappedConnectionPoint === 'left' ? '#22c55e' : '#3b82f6'}
                      stroke="white"
                      strokeWidth={2}
                      className="cursor-crosshair"
                      style={{ pointerEvents: 'none' }}
                    />
                  </>
                );
              })()
            )}
          </g>
        );
      
      case 'path':
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
      
      case 'arrow':
        if (element.endX !== undefined && element.endY !== undefined) {
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
        }
        return null;
      
      default:
        return null;
    }
    };
    
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
                  {stroke && stroke.points && stroke.points.length > 0 && (
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
            {elementContent()}
          </g>
          {renderSelectionBorder()}
        </g>
      );
    }

    return (
      <g key={element.id}>
        {elementContent()}
        {renderSelectionBorder()}
      </g>
    );
  };

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
          <Button
            variant={tool === 'select' ? 'default' : 'ghost'}
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setTool('select')}
            title={st('sweep.weldflow.whiteboardView.selectTool')}
          >
            <MousePointer2 className="h-4 w-4" />
          </Button>
          <Button
            variant={tool === 'pan' ? 'default' : 'ghost'}
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setTool('pan')}
            title={st('sweep.weldflow.whiteboardView.panTool')}
          >
            <Hand className="h-4 w-4" />
          </Button>

          {canWrite && (
            <>
              <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

              <Button
                variant={tool === 'rectangle' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setTool('rectangle')}
                title={st('sweep.weldflow.whiteboardView.rectangleTool')}
              >
                <Square className="h-4 w-4" />
              </Button>
              <Button
                variant={tool === 'circle' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setTool('circle')}
                title={st('sweep.weldflow.whiteboardView.circleTool')}
              >
                <Circle className="h-4 w-4" />
              </Button>
              <Button
                variant={tool === 'arrow' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setTool('arrow')}
                title={st('sweep.weldflow.whiteboardView.arrowTool')}
              >
                <ArrowUpRight className="h-4 w-4" />
              </Button>

              <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

              <Button
                variant={tool === 'text' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setTool('text')}
                title={st('sweep.weldflow.whiteboardView.textTool')}
              >
                <Type className="h-4 w-4" />
              </Button>
              <Button
                variant={tool === 'sticky' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setTool('sticky')}
                title={st('sweep.weldflow.whiteboardView.stickyNoteTool')}
              >
                <StickyNote className="h-4 w-4" />
              </Button>
              <Button
                variant={tool === 'pen' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setTool('pen')}
                title={st('sweep.weldflow.whiteboardView.penTool')}
              >
                <Pen className="h-4 w-4" />
              </Button>
              <Button
                variant={tool === 'eraser' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setTool('eraser')}
                title={st('sweep.weldflow.whiteboardView.eraserTool')}
              >
                <Eraser className="h-4 w-4" />
              </Button>

              <div className="w-px h-6 bg-gray-200 dark:bg-accent mx-1" />

              {/* Color picker */}
          <div className="flex items-center gap-1">
            {colors.map(color => (
              <Button
                variant="ghost"
                key={color}
                className={cn(
                  "h-6 w-6 rounded border-2 transition-all duration-150",
                  selectedColor === color
                    ? "border-gray-500 dark:border-gray-300"
                    : hoveredColor === color && selectedColor !== color
                    ? "border-gray-300 dark:border-gray-500"
                    : "border-transparent"
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
          {(tool === 'pen' || tool === 'rectangle' || tool === 'circle' || tool === 'arrow') && (
            <>
              <div className="w-px h-6 bg-gray-300 dark:bg-accent mx-1" />
              <div className="flex items-center gap-2 px-2 py-1 border border-gray-200 dark:border-border rounded-md bg-white dark:bg-secondary">
                <span className="text-xs text-gray-600 dark:text-muted-foreground">Stroke:</span>
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
                <Button
                  variant={arrowType === 'line' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setArrowType('line')}
                  title={st('sweep.weldflow.whiteboardView.line')}
                >
                  <Minus className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant={arrowType === 'arrow' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setArrowType('arrow')}
                  title={st('sweep.weldflow.whiteboardView.arrow')}
                >
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant={arrowType === 'elbow' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setArrowType('elbow')}
                  title={st('sweep.weldflow.whiteboardView.elbowArrow')}
                >
                  <CornerDownRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </>
          )}
          
          
          {(tool === 'rectangle' || tool === 'circle') && (
            <div className="flex items-center gap-2 ml-2">
              <ToggleGroup type="single" value={fillMode} onValueChange={(value) => value && setFillMode(value as any)}>
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
          
          {(tool === 'text' || tool === 'sticky') && (
            <>
              <div className="w-px h-6 bg-gray-300 dark:bg-accent mx-1" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600 dark:text-muted-foreground">{st('sweep.weldflow.whiteboardView.fontLabel')}</span>
                <Select value={fontSize.toString()} onValueChange={(value) => setFontSize(parseInt(value))}>
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
            isConnected={isConnected}
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
      {selectedElement && !isPresentMode && !isPanning && (() => {
        const element = elements.find(el => el.id === selectedElement);
        if (!element || element.type !== 'text') return null;

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
                  el.id === selectedElement ? { ...el, fontSize: parseInt(value) } : el
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
      {selectedElement && !isPresentMode && !isPanning && (() => {
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
                      <div className="text-xs text-gray-500">Stroke Width</div>
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
          cursor: isMiddleMouseDown || isPanning ? 'grabbing' :
                  tool === 'pan' ? 'grab' :
                  tool === 'select' ? 'default' :
                  tool === 'eraser' ? 'none' :
                  'crosshair',
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
          style={{
            overflow: 'visible',
            // Use translate3d during active interaction for GPU-accelerated smooth performance,
            // switch to regular translate when idle so browser re-rasterizes SVG at correct zoom resolution
            transform: isPanning || isMiddleMouseDown || isTouchActive || isZooming
              ? `translate3d(${panPosition.x}px, ${panPosition.y}px, 0) scale(${zoom})`
              : `translate(${panPosition.x}px, ${panPosition.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            willChange: isPanning || isMiddleMouseDown || isTouchActive || isZooming ? 'transform' : 'auto',
            transition: 'none'
          }}
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
          {elements.map(renderElement)}
          
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
              const distance = Math.sqrt(dx * dx + dy * dy);
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
            <g pointerEvents="none">
              <circle
                cx={currentPoint.x}
                cy={currentPoint.y}
                r={eraserSize}
                fill="none"
                stroke={isErasing ? "#ff0000" : "#ff6464"}
                strokeWidth={isErasing ? 3 : 2}
                strokeDasharray={isErasing ? "none" : "4,2"}
                opacity={isErasing ? 1 : 0.8}
              />
              {/* Inner guide circle to show it's a ring */}
              {!isErasing && (
                <circle
                  cx={currentPoint.x}
                  cy={currentPoint.y}
                  r={Math.max(1, eraserSize - 3)}
                  fill="none"
                  stroke="#ff6464"
                  strokeWidth={1}
                  strokeDasharray="2,2"
                  opacity={0.4}
                />
              )}
            </g>
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