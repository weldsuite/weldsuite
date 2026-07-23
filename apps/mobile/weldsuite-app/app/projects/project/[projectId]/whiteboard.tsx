import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  PanResponder,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useClerkAuth } from '@/contexts/ClerkAuthContext';
import api from '@/services/api';
import Svg, { Path, Rect, Line, G, Text as SvgText, TSpan } from 'react-native-svg';
import {
  Pencil,
  Eraser,
  Trash2,
  Undo2,
  Save,
  Maximize,
  Move,
} from 'lucide-react-native';

interface Point {
  x: number;
  y: number;
}

// Full WhiteboardElement type matching platform
type WhiteboardElement = {
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
  points?: Point[];
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textAlign?: 'left' | 'center' | 'right';
  endX?: number;
  endY?: number;
  arrowType?: 'line' | 'arrow' | 'elbow';
  borderRadius?: number;
  createdAt?: number;
  createdBy?: string;
};

const COLORS = ['#000000', '#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899'];
const STROKE_WIDTHS = [2, 4, 6, 8, 12];

// Default sticky note colors
const STICKY_COLORS = ['#FEF08A', '#FDE68A', '#D9F99D', '#A5F3FC', '#E9D5FF', '#FECACA'];

// Convert points to SVG path string with smooth curves
const pointsToPath = (points: Point[]): string => {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M${points[0].x},${points[0].y} L${points[0].x},${points[0].y}`;
  }

  let path = `M${points[0].x},${points[0].y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    path += ` Q${points[i].x},${points[i].y} ${xc},${yc}`;
  }

  if (points.length > 1) {
    const last = points[points.length - 1];
    path += ` L${last.x},${last.y}`;
  }

  return path;
};

export default function ProjectWhiteboardScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { colors } = useTheme();
  const toast = useToast();
  const { user } = useClerkAuth();

  // Drawing state - now holds all element types
  const [elements, setElements] = useState<WhiteboardElement[]>([]);
  const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
  const [selectedColor, setSelectedColor] = useState('#000000');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showStrokePicker, setShowStrokePicker] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Pan and zoom state for canvas navigation
  const [panOffset, setPanOffset] = useState<Point>({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);

  // Refs for tracking gesture state
  const panStartRef = useRef<Point>({ x: 0, y: 0 });
  const lastPanOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const initialPinchDistanceRef = useRef<number>(0);
  const initialScaleRef = useRef<number>(1);
  const numberOfTouchesRef = useRef<number>(0);

  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);
  const currentPointsRef = useRef<Point[]>([]);

  // Auto-save tracking
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>('[]');
  const initialLoadRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Load whiteboard data from server
  useEffect(() => {
    const loadWhiteboard = async () => {
      if (!projectId) {
        setIsLoading(false);
        return;
      }

      try {
        const response = await api.getProjectWhiteboard(projectId);
        if (response.success && response.data && mountedRef.current) {
          const serverElements = response.data.elements || [];
          // Transform server elements to WhiteboardElement format (all types)
          const loadedElements: WhiteboardElement[] = serverElements
            .filter((el: any) => el.type && el.id)
            .map((el: any): WhiteboardElement => ({
              id: el.id,
              type: el.type,
              x: el.x || 0,
              y: el.y || 0,
              width: el.width,
              height: el.height,
              radius: el.radius,
              radiusX: el.radiusX,
              radiusY: el.radiusY,
              text: el.text,
              color: el.color,
              strokeColor: el.strokeColor || el.color,
              strokeWidth: el.strokeWidth || 4,
              points: el.points,
              fontSize: el.fontSize,
              fontWeight: el.fontWeight,
              fontStyle: el.fontStyle,
              textAlign: el.textAlign,
              endX: el.endX,
              endY: el.endY,
              arrowType: el.arrowType,
              borderRadius: el.borderRadius,
              createdAt: el.createdAt || Date.now(),
              createdBy: el.createdBy,
            }));
          setElements(loadedElements);
          lastSavedRef.current = JSON.stringify(loadedElements);
        }
      } catch (error) {
        console.error('Failed to load whiteboard:', error);
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
          initialLoadRef.current = false;  // Always mark initial load complete
        }
      }
    };

    loadWhiteboard();
  }, [projectId]);

  // Auto-save whiteboard when elements change
  const saveWhiteboard = useCallback(async (elementsToSave: WhiteboardElement[]) => {
    if (!projectId) return;

    const elementsJson = JSON.stringify(elementsToSave);
    if (elementsJson === lastSavedRef.current) return;

    try {
      setIsSaving(true);
      const response = await api.saveProjectWhiteboard(projectId, { elements: elementsToSave });
      if (response.success) {
        lastSavedRef.current = elementsJson;
      }
    } catch (error) {
      console.error('Failed to auto-save whiteboard:', error);
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [projectId]);

  // Debounced auto-save effect
  useEffect(() => {
    // Skip on initial load
    if (initialLoadRef.current) return;

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce save by 1 second
    saveTimeoutRef.current = setTimeout(() => {
      saveWhiteboard(elements);
    }, 1000);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [elements, saveWhiteboard]);


  // Helper to convert screen coordinates to canvas coordinates (accounting for pan/zoom)
  const screenToCanvas = useCallback((screenX: number, screenY: number): Point => {
    return {
      x: (screenX - panOffset.x) / scale,
      y: (screenY - panOffset.y) / scale,
    };
  }, [panOffset, scale]);

  // Calculate distance between two touch points
  const getDistance = (touches: { pageX: number; pageY: number }[]): number => {
    if (touches.length < 2) return 0;
    const dx = touches[0].pageX - touches[1].pageX;
    const dy = touches[0].pageY - touches[1].pageY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Get center point of two touches
  const getCenter = (touches: { pageX: number; pageY: number }[]): Point => {
    if (touches.length < 2) return { x: touches[0]?.pageX || 0, y: touches[0]?.pageY || 0 };
    return {
      x: (touches[0].pageX + touches[1].pageX) / 2,
      y: (touches[0].pageY + touches[1].pageY) / 2,
    };
  };

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => {
      const touches = evt.nativeEvent.touches;
      numberOfTouchesRef.current = touches.length;

      setShowColorPicker(false);
      setShowStrokePicker(false);

      if (touches.length >= 2) {
        // Two-finger gesture - start panning/zooming
        setIsPanning(true);
        const center = getCenter(Array.from(touches) as any);
        panStartRef.current = center;
        lastPanOffsetRef.current = { ...panOffset };
        initialPinchDistanceRef.current = getDistance(Array.from(touches) as any);
        initialScaleRef.current = scale;
      } else {
        // Single finger - start drawing
        setIsPanning(false);
        const { locationX, locationY } = evt.nativeEvent;
        const canvasPoint = screenToCanvas(locationX, locationY);
        const initialPoints = [canvasPoint];
        currentPointsRef.current = initialPoints;
        setCurrentPoints(initialPoints);

      }
    },
    onPanResponderMove: (evt) => {
      const touches = evt.nativeEvent.touches;
      const currentTouches = touches.length;

      // Handle transition from 1 to 2 fingers
      if (currentTouches >= 2 && numberOfTouchesRef.current < 2) {
        // Switched to two-finger mode - cancel any drawing and start panning
        setIsPanning(true);
        currentPointsRef.current = [];
        setCurrentPoints([]);
        const center = getCenter(Array.from(touches) as any);
        panStartRef.current = center;
        lastPanOffsetRef.current = { ...panOffset };
        initialPinchDistanceRef.current = getDistance(Array.from(touches) as any);
        initialScaleRef.current = scale;
        numberOfTouchesRef.current = currentTouches;
        return;
      }

      numberOfTouchesRef.current = currentTouches;

      if (currentTouches >= 2) {
        // Two-finger gesture - pan and zoom
        const center = getCenter(Array.from(touches) as any);
        const dx = center.x - panStartRef.current.x;
        const dy = center.y - panStartRef.current.y;

        // Update pan offset
        setPanOffset({
          x: lastPanOffsetRef.current.x + dx,
          y: lastPanOffsetRef.current.y + dy,
        });

        // Optional: Pinch to zoom
        const currentDistance = getDistance(Array.from(touches) as any);
        if (initialPinchDistanceRef.current > 0 && currentDistance > 0) {
          const newScale = Math.max(0.5, Math.min(3, initialScaleRef.current * (currentDistance / initialPinchDistanceRef.current)));
          setScale(newScale);
        }
      } else if (!isPanning && currentTouches === 1) {
        // Single finger - continue drawing
        const { locationX, locationY } = evt.nativeEvent;
        const canvasPoint = screenToCanvas(locationX, locationY);
        const newPoints = [...currentPointsRef.current, canvasPoint];
        currentPointsRef.current = newPoints;
        setCurrentPoints(newPoints);

      }
    },
    onPanResponderRelease: () => {
      // End panning mode
      if (isPanning) {
        setIsPanning(false);
        numberOfTouchesRef.current = 0;
        return;
      }

      // End drawing - create element
      const points = currentPointsRef.current;
      if (points.length > 0) {
        const pathColor = tool === 'eraser' ? '#FFFFFF' : selectedColor;
        const pathStrokeWidth = tool === 'eraser' ? strokeWidth * 4 : strokeWidth;

        const newElement: WhiteboardElement = {
          id: `path_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type: 'path',
          x: 0,          // Paths use points, so x/y are 0
          y: 0,
          points: [...points],
          color: pathColor,
          strokeColor: pathColor,
          strokeWidth: pathStrokeWidth,
          createdAt: Date.now(),
          createdBy: user?.id,
        };

        setElements((prev) => [...prev, newElement]);
        currentPointsRef.current = [];
        setCurrentPoints([]);
      }

      numberOfTouchesRef.current = 0;
    },
  }), [tool, selectedColor, strokeWidth, user?.id, panOffset, scale, isPanning, screenToCanvas]);

  const handleUndo = () => {
    setElements((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    setElements([]);
    setCurrentPoints([]);
  };

  const handleSave = async () => {
    if (elements.length === 0) {
      toast.info('Nothing to save');
      return;
    }

    setIsSaving(true);
    try {
      await saveWhiteboard(elements);
      toast.success('Whiteboard saved');
    } catch (error) {
      console.error('Failed to save whiteboard:', error);
      toast.error('Failed to save whiteboard');
    } finally {
      setIsSaving(false);
    }
  };

  // Reset view to default pan/zoom
  const handleResetView = () => {
    setPanOffset({ x: 0, y: 0 });
    setScale(1);
  };

  // Check if view is modified from default
  const isViewModified = panOffset.x !== 0 || panOffset.y !== 0 || scale !== 1;

  if (isLoading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>
          Loading whiteboard...
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Toolbar */}
      <View style={[styles.toolbar, { backgroundColor: colors.card, borderBottomColor: colors.divider }]}>
        {/* Tools */}
        <View style={styles.toolGroup}>
          <TouchableOpacity
            style={[
              styles.toolButton,
              tool === 'pen' && styles.toolButtonActive,
            ]}
            onPress={() => setTool('pen')}
          >
            <Pencil size={20} color={tool === 'pen' ? '#3B82F6' : colors.muted} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.toolButton,
              tool === 'eraser' && styles.toolButtonActive,
            ]}
            onPress={() => setTool('eraser')}
          >
            <Eraser size={20} color={tool === 'eraser' ? '#3B82F6' : colors.muted} strokeWidth={2} />
          </TouchableOpacity>
        </View>

        {/* Color Picker */}
        <View style={styles.toolGroup}>
          <TouchableOpacity
            style={[styles.colorButton, { backgroundColor: selectedColor }]}
            onPress={() => {
              setShowColorPicker(!showColorPicker);
              setShowStrokePicker(false);
            }}
          />
          {showColorPicker && (
            <View style={[styles.pickerDropdown, { backgroundColor: colors.card }]}>
              {COLORS.map((color) => (
                <TouchableOpacity
                  key={color}
                  style={[
                    styles.colorOption,
                    { backgroundColor: color },
                    selectedColor === color && styles.colorOptionSelected,
                  ]}
                  onPress={() => {
                    setSelectedColor(color);
                    setShowColorPicker(false);
                  }}
                />
              ))}
            </View>
          )}
        </View>

        {/* Stroke Width */}
        <View style={styles.toolGroup}>
          <TouchableOpacity
            style={styles.toolButton}
            onPress={() => {
              setShowStrokePicker(!showStrokePicker);
              setShowColorPicker(false);
            }}
          >
            <View style={[styles.strokeIndicator, { backgroundColor: colors.text, height: Math.min(strokeWidth, 8) }]} />
          </TouchableOpacity>
          {showStrokePicker && (
            <View style={[styles.strokeDropdown, { backgroundColor: colors.card }]}>
              {STROKE_WIDTHS.map((width) => (
                <TouchableOpacity
                  key={width}
                  style={[
                    styles.strokeOption,
                    strokeWidth === width && { backgroundColor: '#3B82F620' },
                  ]}
                  onPress={() => {
                    setStrokeWidth(width);
                    setShowStrokePicker(false);
                  }}
                >
                  <View
                    style={[
                      styles.strokePreview,
                      { height: width, backgroundColor: colors.text },
                    ]}
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Actions */}
        <View style={styles.toolGroup}>
          {/* Reset view button - only show when view is modified */}
          {isViewModified && (
            <TouchableOpacity
              style={styles.toolButton}
              onPress={handleResetView}
            >
              <Maximize size={20} color="#3B82F6" strokeWidth={2} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.toolButton}
            onPress={handleUndo}
            disabled={elements.length === 0}
          >
            <Undo2 size={20} color={elements.length === 0 ? colors.divider : colors.text} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.toolButton}
            onPress={handleClear}
            disabled={elements.length === 0}
          >
            <Trash2 size={20} color={elements.length === 0 ? colors.divider : '#EF4444'} strokeWidth={2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.saveButton, (isSaving || elements.length === 0) && { opacity: 0.5 }]}
            onPress={handleSave}
            disabled={isSaving || elements.length === 0}
          >
            <Save size={18} color="#FFFFFF" strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Canvas */}
      <View style={styles.canvasContainer} {...panResponder.panHandlers}>
        <Svg style={styles.canvas}>
          {/* Apply pan and zoom transform to all canvas content */}
          <G transform={`translate(${panOffset.x}, ${panOffset.y}) scale(${scale})`}>
            {/* Render all elements */}
            {elements.map((element) => {
              switch (element.type) {
                case 'path':
                  if (!element.points || element.points.length === 0) return null;
                  return (
                    <Path
                      key={element.id}
                      d={pointsToPath(element.points)}
                      stroke={element.strokeColor || element.color || '#000000'}
                      strokeWidth={element.strokeWidth || 4}
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );

              case 'rectangle':
                return (
                  <Rect
                    key={element.id}
                    x={element.x}
                    y={element.y}
                    width={element.width || 100}
                    height={element.height || 100}
                    rx={element.borderRadius || 0}
                    ry={element.borderRadius || 0}
                    fill={element.color === 'transparent' ? 'none' : (element.color || 'none')}
                    stroke={element.strokeColor === 'transparent' ? 'none' : (element.strokeColor || '#000000')}
                    strokeWidth={element.strokeWidth || 2}
                  />
                );

              case 'circle':
                // Support both legacy radius and new radiusX/radiusY for ellipses
                const rx = element.radiusX ?? element.radius ?? 50;
                const ry = element.radiusY ?? element.radius ?? 50;
                return (
                  <G key={element.id}>
                    {/* Ellipse - react-native-svg uses ellipse for non-circular shapes */}
                    <Rect
                      x={element.x - rx}
                      y={element.y - ry}
                      width={rx * 2}
                      height={ry * 2}
                      rx={rx}
                      ry={ry}
                      fill={element.color === 'transparent' ? 'none' : (element.color || 'none')}
                      stroke={element.strokeColor === 'transparent' ? 'none' : (element.strokeColor || '#000000')}
                      strokeWidth={element.strokeWidth || 2}
                    />
                  </G>
                );

              case 'text':
                const textLines = (element.text || '').split('\n');
                const lineHeight = (element.fontSize || 16) * 1.2;
                return (
                  <SvgText
                    key={element.id}
                    x={element.x}
                    y={element.y}
                    fill={element.color || '#000000'}
                    fontSize={element.fontSize || 16}
                    fontWeight={element.fontWeight || 'normal'}
                    fontStyle={element.fontStyle || 'normal'}
                  >
                    {textLines.map((line, index) => (
                      <TSpan
                        key={index}
                        x={element.x}
                        dy={index === 0 ? 0 : lineHeight}
                      >
                        {line}
                      </TSpan>
                    ))}
                  </SvgText>
                );

              case 'sticky':
                const stickyWidth = element.width || 200;
                const stickyHeight = element.height || 200;
                const stickyColor = element.color || '#FEF08A';
                const stickyTextLines = (element.text || '').split('\n');
                const stickyFontSize = element.fontSize || 14;
                const stickyLineHeight = stickyFontSize * 1.3;
                return (
                  <G key={element.id}>
                    {/* Sticky note background */}
                    <Rect
                      x={element.x}
                      y={element.y}
                      width={stickyWidth}
                      height={stickyHeight}
                      fill={stickyColor}
                      rx={4}
                      ry={4}
                    />
                    {/* Sticky note text */}
                    <SvgText
                      x={element.x + 12}
                      y={element.y + 20}
                      fill="#333333"
                      fontSize={stickyFontSize}
                    >
                      {stickyTextLines.map((line, index) => (
                        <TSpan
                          key={index}
                          x={element.x + 12}
                          dy={index === 0 ? 0 : stickyLineHeight}
                        >
                          {line.length > 25 ? line.substring(0, 25) + '...' : line}
                        </TSpan>
                      ))}
                    </SvgText>
                  </G>
                );

              case 'arrow':
                if (element.endX === undefined || element.endY === undefined) return null;
                const arrowStroke = element.strokeColor || '#000000';
                const arrowWidth = element.strokeWidth || 2;

                // Calculate arrow head
                const angle = Math.atan2(element.endY - element.y, element.endX - element.x);
                const headLength = 10;
                const headAngle = Math.PI / 6;

                const arrowHeadX1 = element.endX - headLength * Math.cos(angle - headAngle);
                const arrowHeadY1 = element.endY - headLength * Math.sin(angle - headAngle);
                const arrowHeadX2 = element.endX - headLength * Math.cos(angle + headAngle);
                const arrowHeadY2 = element.endY - headLength * Math.sin(angle + headAngle);

                if (element.arrowType === 'elbow') {
                  // Elbow arrow: horizontal then vertical
                  const midX = element.x + (element.endX - element.x) / 2;
                  const elbowPath = `M ${element.x} ${element.y} L ${midX} ${element.y} L ${midX} ${element.endY} L ${element.endX} ${element.endY}`;
                  return (
                    <G key={element.id}>
                      <Path
                        d={elbowPath}
                        stroke={arrowStroke}
                        strokeWidth={arrowWidth}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      {/* Elbow arrows always have arrow heads */}
                      <Path
                        d={`M ${arrowHeadX1} ${arrowHeadY1} L ${element.endX} ${element.endY} L ${arrowHeadX2} ${arrowHeadY2}`}
                        stroke={arrowStroke}
                        strokeWidth={arrowWidth}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </G>
                  );
                } else {
                  // Straight line/arrow
                  return (
                    <G key={element.id}>
                      <Line
                        x1={element.x}
                        y1={element.y}
                        x2={element.endX}
                        y2={element.endY}
                        stroke={arrowStroke}
                        strokeWidth={arrowWidth}
                        strokeLinecap="round"
                      />
                      {element.arrowType === 'arrow' && (
                        <Path
                          d={`M ${arrowHeadX1} ${arrowHeadY1} L ${element.endX} ${element.endY} L ${arrowHeadX2} ${arrowHeadY2}`}
                          stroke={arrowStroke}
                          strokeWidth={arrowWidth}
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      )}
                    </G>
                  );
                }

              default:
                return null;
            }
          })}
            {/* Current drawing path */}
            {currentPoints.length > 0 && (
              <Path
                d={pointsToPath(currentPoints)}
                stroke={tool === 'eraser' ? '#FFFFFF' : selectedColor}
                strokeWidth={tool === 'eraser' ? strokeWidth * 4 : strokeWidth}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </G>
        </Svg>
        {/* Pan indicator overlay */}
        {isPanning && (
          <View style={styles.panIndicator}>
            <Move size={24} color="#3B82F6" strokeWidth={2} />
          </View>
        )}
      </View>

      {/* Status indicators */}
      <View style={[styles.statusBar, { backgroundColor: colors.card }]}>
        {/* Saving indicator */}
        {isSaving && (
          <View style={styles.statusItem}>
            <ActivityIndicator size="small" color={colors.muted} />
            <Text style={[styles.statusText, { color: colors.muted }]}>Saving...</Text>
          </View>
        )}

        {/* Tool indicator */}
        <View style={styles.statusItem}>
          <Text style={[styles.statusText, { color: colors.muted }]}>
            {tool === 'pen' ? 'Draw' : 'Erase'}
          </Text>
        </View>

        {/* Zoom level */}
        {scale !== 1 && (
          <Text style={[styles.statusText, { color: colors.muted }]}>
            {Math.round(scale * 100)}%
          </Text>
        )}

        {/* Element count */}
        <Text style={[styles.statusText, { color: colors.muted }]}>
          {elements.length} elements
        </Text>
      </View>

      {/* Instructions */}
      {elements.length === 0 && currentPoints.length === 0 && !isPanning && (
        <View style={styles.instructions} pointerEvents="none">
          <Text style={[styles.instructionText, { color: colors.muted }]}>
            Draw with one finger
          </Text>
          <Text style={[styles.instructionSubtext, { color: colors.muted }]}>
            Pan with two fingers
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 14,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    zIndex: 100,
  },
  toolGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    position: 'relative',
  },
  toolButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toolButtonActive: {
    backgroundColor: '#3B82F620',
  },
  colorButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#E5E7EB',
  },
  pickerDropdown: {
    position: 'absolute',
    top: 48,
    left: -20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 8,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    zIndex: 1000,
    gap: 6,
    width: 130,
  },
  colorOption: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  colorOptionSelected: {
    borderWidth: 3,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 3,
  },
  strokeIndicator: {
    width: 20,
    borderRadius: 4,
  },
  strokeDropdown: {
    position: 'absolute',
    top: 48,
    left: -10,
    padding: 6,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    zIndex: 1000,
    width: 80,
  },
  strokeOption: {
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  strokePreview: {
    width: 50,
    borderRadius: 4,
  },
  saveButton: {
    backgroundColor: '#3B82F6',
    width: 40,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  canvasContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  canvas: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  statusBar: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statusItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  presenceAvatars: {
    flexDirection: 'row',
    marginLeft: 4,
  },
  presenceAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: -6,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  presenceAvatarText: {
    fontSize: 9,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  instructions: {
    position: 'absolute',
    top: '50%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  instructionText: {
    fontSize: 14,
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
  },
  instructionSubtext: {
    fontSize: 12,
    marginTop: 4,
  },
  panIndicator: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 60,
    height: 60,
    marginLeft: -30,
    marginTop: -30,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
});
