import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
  useWindowDimensions,
  Platform,
  KeyboardAvoidingView,
  Pressable,
  Keyboard,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '@/services/api';
import Svg, { Path } from 'react-native-svg';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import {
  Target,
  Plus,
  Edit3,
  Trash2,
  X,
  ChevronDown,
  MessageSquare,
  Save,
  ZoomIn,
  ZoomOut,
  MoreHorizontal,
  AtSign,
  Image,
  Paperclip,
  Settings,
  Check,
  ChevronUp,
  ArrowUp,
} from 'lucide-react-native';
import { DetailPanel, DetailPanelSubItem } from '@/components/projects/DetailPanel';

// Light mode colors
const colors = {
  background: '#F8F9FA',
  card: '#FFFFFF',
  text: '#111827',
  muted: '#6B7280',
  border: '#E5E7EB',
  subtle: '#F3F4F6',
  primary: '#3B82F6',
};

// Status colors
const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  not_started: { label: 'Not Started', bg: '#FEE2E2', text: '#DC2626' },
  in_progress: { label: 'On Track', bg: '#CFFAFE', text: '#0891B2' },
  at_risk: { label: 'At Risk', bg: '#FEF3C7', text: '#D97706' },
  completed: { label: 'Completed', bg: '#D1FAE5', text: '#059669' },
};

interface Goal {
  id: string;
  title: string;
  description?: string;
  status: 'not_started' | 'in_progress' | 'at_risk' | 'completed';
  priority: 'low' | 'medium' | 'high';
  dueDate?: string;
  timeframe?: string;
  parentId?: string;
  subgoalsCount?: number;
  completedSubgoals?: number;
  progress?: number;
  tasksCount?: number;
  owner?: string;
  color?: string;
}

interface Mission {
  title: string;
  description?: string;
  vision?: string;
}

interface ProjectGoalsData {
  id?: string;
  mission?: Mission;
  goals: Goal[];
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

// Card dimensions
const CARD_WIDTH = 220;
const CARD_HEIGHT = 140;
const CARD_GAP_X = 60;
const CARD_GAP_Y = 80;
const MISSION_CARD_WIDTH = 240;
const MISSION_CARD_HEIGHT = 100;

export default function ProjectGoalsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { width, height } = useWindowDimensions();
  const scrollViewRef = useRef<ScrollView>(null);

  // State
  const [goalsData, setGoalsData] = useState<ProjectGoalsData>({ goals: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(100);

  // Gesture values for pinch-to-zoom
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const lastScale = useSharedValue(1);

  // Helper to update zoom state safely from worklet
  const updateZoomState = (newZoom: number) => {
    setZoom(newZoom);
  };

  // Pinch gesture with smoother handling
  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      lastScale.value = scale.value;
    })
    .onUpdate((event) => {
      const newScale = lastScale.value * event.scale;
      scale.value = Math.min(Math.max(newScale, 0.5), 2);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      runOnJS(updateZoomState)(Math.round(scale.value * 100));
    });

  // Pan gesture for moving around
  const panGesture = Gesture.Pan()
    .onStart(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onUpdate((event) => {
      translateX.value = savedTranslateX.value + event.translationX;
      translateY.value = savedTranslateY.value + event.translationY;
    });

  // Double tap to reset zoom
  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      scale.value = 1;
      savedScale.value = 1;
      lastScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
      runOnJS(updateZoomState)(100);
    });

  // Combine gestures - pinch, pan, and double tap
  const composedGesture = Gesture.Simultaneous(
    pinchGesture,
    panGesture,
    doubleTapGesture
  );

  // Animated style for the canvas content
  const animatedCanvasStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // Button zoom controls
  const handleZoomIn = () => {
    const newScale = Math.min(scale.value + 0.1, 2);
    scale.value = newScale;
    savedScale.value = newScale;
    lastScale.value = newScale;
    setZoom(Math.round(newScale * 100));
  };

  const handleZoomOut = () => {
    const newScale = Math.max(scale.value - 0.1, 0.5);
    scale.value = newScale;
    savedScale.value = newScale;
    lastScale.value = newScale;
    setZoom(Math.round(newScale * 100));
  };

  const handleResetZoom = () => {
    scale.value = 1;
    savedScale.value = 1;
    lastScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    setZoom(100);
  };

  // Modal state
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [showMissionModal, setShowMissionModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [deletingGoal, setDeletingGoal] = useState<Goal | null>(null);
  const [parentGoalId, setParentGoalId] = useState<string | null>(null);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);

  // Form state
  const [goalTitle, setGoalTitle] = useState('');
  const [goalDescription, setGoalDescription] = useState('');
  const [goalStatus, setGoalStatus] = useState<Goal['status']>('not_started');
  const [goalTimeframe, setGoalTimeframe] = useState('Q4 FY25');
  const [missionTitle, setMissionTitle] = useState('');
  const [missionDescription, setMissionDescription] = useState('');

  // Load goals
  const loadGoals = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await api.getProjectGoals(projectId);
      if (response.success && response.data) {
        setGoalsData({
          ...response.data,
          goals: Array.isArray(response.data.goals) ? response.data.goals.filter(Boolean) : [],
        });
        if (response.data.mission) {
          setMissionTitle(response.data.mission.title || '');
          setMissionDescription(response.data.mission.description || '');
        }
      }
    } catch (error) {
      console.error('Failed to load goals:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadGoals();
  }, [loadGoals]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadGoals();
  }, [loadGoals]);

  // Get root goals (no parent)
  const rootGoals = goalsData.goals.filter(g => !g.parentId);

  // Get children of a goal
  const getChildGoals = (parentId: string) =>
    goalsData.goals.filter(g => g.parentId === parentId);

  // Calculate positions for goals in tree layout
  const calculateLayout = () => {
    const positions: Record<string, { x: number; y: number; children: string[] }> = {};

    // Start with mission at top center
    const canvasWidth = Math.max(width, 800);
    const centerX = canvasWidth / 2;

    let currentY = 40;

    // Mission position
    positions['mission'] = { x: centerX - MISSION_CARD_WIDTH / 2, y: currentY, children: [] };
    currentY += MISSION_CARD_HEIGHT + CARD_GAP_Y;

    // Position root goals
    const rootWidth = rootGoals.length * CARD_WIDTH + (rootGoals.length - 1) * CARD_GAP_X;
    let rootStartX = centerX - rootWidth / 2;

    rootGoals.forEach((goal, index) => {
      const x = rootStartX + index * (CARD_WIDTH + CARD_GAP_X);
      positions[goal.id] = { x, y: currentY, children: [] };

      // Position children recursively
      const positionChildren = (parentId: string, parentX: number, level: number) => {
        const children = getChildGoals(parentId);
        if (children.length === 0) return;

        const childY = currentY + (level * (CARD_HEIGHT + CARD_GAP_Y));
        const childWidth = children.length * CARD_WIDTH + (children.length - 1) * CARD_GAP_X;
        let childStartX = parentX + CARD_WIDTH / 2 - childWidth / 2;

        children.forEach((child, idx) => {
          const childX = childStartX + idx * (CARD_WIDTH + CARD_GAP_X);
          positions[child.id] = { x: childX, y: childY, children: [] };
          positions[parentId].children.push(child.id);
          positionChildren(child.id, childX, level + 1);
        });
      };

      positionChildren(goal.id, x, 1);
    });

    return positions;
  };

  const positions = calculateLayout();

  // Calculate canvas size
  const getCanvasSize = () => {
    let maxX = width;
    let maxY = 600;

    Object.values(positions).forEach(pos => {
      maxX = Math.max(maxX, pos.x + CARD_WIDTH + 100);
      maxY = Math.max(maxY, pos.y + CARD_HEIGHT + 100);
    });

    return { width: maxX, height: maxY };
  };

  const canvasSize = getCanvasSize();

  // Handle goal actions
  const handleCreateGoal = (parentId?: string) => {
    setEditingGoal(null);
    setParentGoalId(parentId || null);
    setGoalTitle('');
    setGoalDescription('');
    setGoalStatus('not_started');
    setGoalTimeframe('Q4 FY25');
    setShowGoalModal(true);
  };

  const handleEditGoal = (goal: Goal) => {
    setEditingGoal(goal);
    setParentGoalId(goal.parentId || null);
    setGoalTitle(goal.title);
    setGoalDescription(goal.description || '');
    setGoalStatus(goal.status);
    setGoalTimeframe(goal.timeframe || 'Q4 FY25');
    setShowGoalModal(true);
  };

  const handleSaveGoal = async () => {
    if (!projectId || !goalTitle.trim()) return;
    setSaving(true);
    try {
      let updatedGoals: Goal[];

      if (editingGoal) {
        updatedGoals = goalsData.goals.map(g =>
          g.id === editingGoal.id
            ? { ...g, title: goalTitle, description: goalDescription, status: goalStatus, timeframe: goalTimeframe }
            : g
        );
      } else {
        const newGoal: Goal = {
          id: `goal_${Date.now()}`,
          title: goalTitle,
          description: goalDescription,
          status: goalStatus,
          priority: 'medium',
          timeframe: goalTimeframe,
          parentId: parentGoalId || undefined,
          progress: 0,
          subgoalsCount: 0,
          completedSubgoals: 0,
          tasksCount: 0,
        };
        updatedGoals = [...goalsData.goals, newGoal];
      }

      const response = await api.saveProjectGoals(projectId, {
        mission: goalsData.mission,
        goals: updatedGoals,
      });

      if (response.success) {
        setGoalsData(prev => ({ ...prev, goals: updatedGoals }));
        setShowGoalModal(false);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to save goal');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteGoal = async () => {
    if (!projectId || !deletingGoal) return;
    try {
      // Delete goal and all its children
      const idsToDelete = new Set<string>();
      const collectChildren = (id: string) => {
        idsToDelete.add(id);
        getChildGoals(id).forEach(child => collectChildren(child.id));
      };
      collectChildren(deletingGoal.id);

      const updatedGoals = goalsData.goals.filter(g => !idsToDelete.has(g.id));

      const response = await api.saveProjectGoals(projectId, {
        mission: goalsData.mission,
        goals: updatedGoals,
      });

      if (response.success) {
        setGoalsData(prev => ({ ...prev, goals: updatedGoals }));
        setShowDeleteConfirm(false);
        setDeletingGoal(null);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to delete goal');
    }
  };

  const handleSaveMission = async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      const response = await api.saveProjectGoals(projectId, {
        mission: { title: missionTitle, description: missionDescription },
        goals: goalsData.goals,
      });
      if (response.success) {
        setGoalsData(prev => ({
          ...prev,
          mission: { title: missionTitle, description: missionDescription },
        }));
        setShowMissionModal(false);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to save mission');
    } finally {
      setSaving(false);
    }
  };

  // Render connecting lines with smooth curves
  const renderConnections = () => {
    const lines: React.ReactNode[] = [];
    const curveRadius = 20; // Radius for the curved corners

    // Helper to create a smooth curved path
    const createCurvedPath = (
      startX: number,
      startY: number,
      endX: number,
      endY: number
    ) => {
      const midY = startY + (endY - startY) / 2;

      if (startX === endX) {
        // Straight vertical line
        return `M ${startX} ${startY} L ${endX} ${endY}`;
      }

      const goingRight = endX > startX;
      const horizontalDist = Math.abs(endX - startX);
      const radius = Math.min(curveRadius, horizontalDist / 2, (endY - startY) / 4);

      // Create path with quadratic bezier curves for smooth corners
      return `
        M ${startX} ${startY}
        L ${startX} ${midY - radius}
        Q ${startX} ${midY} ${startX + (goingRight ? radius : -radius)} ${midY}
        L ${endX - (goingRight ? radius : -radius)} ${midY}
        Q ${endX} ${midY} ${endX} ${midY + radius}
        L ${endX} ${endY}
      `;
    };

    // Connect mission to root goals
    if (positions['mission'] && rootGoals.length > 0) {
      const missionBottom = positions['mission'].y + MISSION_CARD_HEIGHT;
      const missionCenterX = positions['mission'].x + MISSION_CARD_WIDTH / 2;

      rootGoals.forEach((goal) => {
        const goalPos = positions[goal.id];
        if (!goalPos) return;

        const goalTop = goalPos.y;
        const goalCenterX = goalPos.x + CARD_WIDTH / 2;

        lines.push(
          <Path
            key={`mission-${goal.id}`}
            d={createCurvedPath(missionCenterX, missionBottom, goalCenterX, goalTop)}
            stroke="#D1D5DB"
            strokeWidth={2}
            fill="none"
          />
        );
      });
    }

    // Connect parent goals to children
    goalsData.goals.forEach(goal => {
      const children = getChildGoals(goal.id);
      if (children.length === 0) return;

      const parentPos = positions[goal.id];
      if (!parentPos) return;

      const parentBottom = parentPos.y + CARD_HEIGHT;
      const parentCenterX = parentPos.x + CARD_WIDTH / 2;

      children.forEach(child => {
        const childPos = positions[child.id];
        if (!childPos) return;

        const childTop = childPos.y;
        const childCenterX = childPos.x + CARD_WIDTH / 2;

        lines.push(
          <Path
            key={`${goal.id}-${child.id}`}
            d={createCurvedPath(parentCenterX, parentBottom, childCenterX, childTop)}
            stroke="#D1D5DB"
            strokeWidth={2}
            fill="none"
          />
        );
      });
    });

    return lines;
  };

  // Render mission card
  const renderMissionCard = () => {
    const pos = positions['mission'];
    if (!pos) return null;

    const hasMission = goalsData.mission?.title;

    return (
      <View
        style={[styles.missionCard, { left: pos.x, top: pos.y, width: MISSION_CARD_WIDTH, height: MISSION_CARD_HEIGHT }]}
      >
        <Text style={styles.missionLabel}>Our mission</Text>
        <Text style={styles.missionTitle} numberOfLines={2}>
          {hasMission ? goalsData.mission!.title : 'Define your mission'}
        </Text>
      </View>
    );
  };

  // Render goal card
  const renderGoalCard = (goal: Goal) => {
    if (!goal) return null;

    const pos = positions[goal.id];
    if (!pos) return null;

    const statusConfig = STATUS_CONFIG[goal.status] || STATUS_CONFIG.not_started;
    const children = getChildGoals(goal.id);
    const progress = goal.progress || 0;
    const subgoalsText = `${goal.completedSubgoals || 0} / ${children.length || goal.subgoalsCount || 0} subgoals`;

    return (
      <View
        key={goal.id}
        style={[styles.goalCard, { left: pos.x, top: pos.y, width: CARD_WIDTH, height: CARD_HEIGHT }]}
      >
        {/* Header row */}
        <View style={styles.goalCardHeader}>
          <View style={[styles.statusBadge, { backgroundColor: statusConfig.bg }]}>
            <Text style={[styles.statusText, { color: statusConfig.text }]}>{statusConfig.label}</Text>
          </View>
          <View style={styles.avatarBadge}>
            <Text style={styles.avatarText}>{typeof goal.owner === 'string' ? goal.owner.charAt(0).toUpperCase() : 'W'}</Text>
          </View>
        </View>

        {/* Title */}
        <Text style={styles.goalTitle} numberOfLines={1}>{goal.title}</Text>
        <Text style={styles.subgoalsText}>{subgoalsText}</Text>

        {/* Progress bar */}
        <View style={styles.progressContainer}>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.progressText}>{progress}%</Text>
        </View>

        {/* Footer */}
        <View style={styles.goalCardFooter}>
          <Text style={styles.timeframeText}>{goal.timeframe || 'Q4 FY25'}</Text>
          <View style={styles.tasksCount}>
            <MessageSquare size={12} color={colors.muted} />
            <Text style={styles.tasksCountText}>{goal.tasksCount || 0}</Text>
          </View>
        </View>

        {/* Add subgoal button */}
        <View style={styles.expandButtonContainer}>
          <TouchableOpacity
            style={styles.expandButton}
            onPress={() => handleCreateGoal(goal.id)}
          >
            <Plus size={12} color={colors.muted} strokeWidth={2.5} />
          </TouchableOpacity>
        </View>

        {/* Click to open detail panel, long press for delete */}
        <TouchableOpacity
          style={styles.cardOverlay}
          onPress={() => setSelectedGoal(goal)}
          onLongPress={() => {
            setDeletingGoal(goal);
            setShowDeleteConfirm(true);
          }}
        />
      </View>
    );
  };

  // Render header toolbar
  const renderToolbar = () => (
    <View style={styles.toolbar}>
      <View style={styles.toolbarLeft}>
        <TouchableOpacity style={styles.toolbarButton}>
          <Text style={styles.toolbarButtonText}>Time periods</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolbarButton}>
          <Text style={styles.toolbarButtonText}>Highlight</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.toolbarButton}>
          <Text style={styles.toolbarButtonText}>Filter</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.toolbarRight}>
        <TouchableOpacity
          style={styles.createButton}
          onPress={() => handleCreateGoal()}
        >
          <Plus size={16} color="#FFFFFF" strokeWidth={2.5} />
          <Text style={styles.createButtonText}>Create goal</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // Get subgoals for selected goal as DetailPanelSubItems
  const getSubItemsForPanel = (): DetailPanelSubItem[] => {
    if (!selectedGoal) return [];
    return getChildGoals(selectedGoal.id).map(child => ({
      id: child.id,
      title: child.title,
      status: child.status,
    }));
  };

  // Render goal modal
  const renderGoalModal = () => (
    <Modal
      visible={showGoalModal}
      transparent
      animationType="fade"
      onRequestClose={() => setShowGoalModal(false)}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setShowGoalModal(false)}
        />
        <View style={styles.sheetContent}>
          {/* Header */}
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {editingGoal ? 'Edit goal' : 'Create goal'}
            </Text>
            <TouchableOpacity
              style={styles.sheetCloseButton}
              onPress={() => setShowGoalModal(false)}
            >
              <X size={16} color={colors.muted} />
            </TouchableOpacity>
          </View>

          {/* Form */}
          <View style={styles.sheetBody}>
            <View style={styles.formField}>
              <Text style={styles.formLabel}>Title</Text>
              <TextInput
                style={styles.formInput}
                placeholder="Enter goal title"
                placeholderTextColor="#A1A1AA"
                value={goalTitle}
                onChangeText={setGoalTitle}
              />
            </View>

            <View style={styles.formField}>
              <Text style={styles.formLabel}>Description</Text>
              <TextInput
                style={[styles.formInput, styles.formTextArea]}
                placeholder="Describe your goal (optional)"
                placeholderTextColor="#A1A1AA"
                value={goalDescription}
                onChangeText={setGoalDescription}
                multiline
                numberOfLines={3}
              />
            </View>

            <View style={styles.formField}>
              <Text style={styles.formLabel}>Status</Text>
              <View style={styles.statusGrid}>
                {Object.entries(STATUS_CONFIG).map(([key, config]) => (
                  <TouchableOpacity
                    key={key}
                    style={[
                      styles.statusChip,
                      goalStatus === key && styles.statusChipSelected,
                    ]}
                    onPress={() => setGoalStatus(key as Goal['status'])}
                  >
                    <View style={[styles.statusDot, { backgroundColor: config.text }]} />
                    <Text style={[
                      styles.statusChipText,
                      goalStatus === key && styles.statusChipTextSelected,
                    ]}>
                      {config.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.formField}>
              <Text style={styles.formLabel}>Timeframe</Text>
              <TextInput
                style={styles.formInput}
                placeholder="e.g. Q4 FY25"
                placeholderTextColor="#A1A1AA"
                value={goalTimeframe}
                onChangeText={setGoalTimeframe}
              />
            </View>
          </View>

          {/* Footer */}
          <View style={styles.sheetFooter}>
            <TouchableOpacity
              style={styles.sheetCancelButton}
              onPress={() => setShowGoalModal(false)}
            >
              <Text style={styles.sheetCancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.sheetPrimaryButton,
                (!goalTitle.trim() || saving) && styles.sheetPrimaryButtonDisabled,
              ]}
              onPress={handleSaveGoal}
              disabled={saving || !goalTitle.trim()}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.sheetPrimaryButtonText}>
                  {editingGoal ? 'Save changes' : 'Create goal'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );

  // Render mission modal
  const renderMissionModal = () => (
    <Modal
      visible={showMissionModal}
      transparent
      animationType="fade"
      onRequestClose={() => setShowMissionModal(false)}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Mission</Text>
            <TouchableOpacity onPress={() => setShowMissionModal(false)}>
              <X size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Mission title"
            placeholderTextColor={colors.muted}
            value={missionTitle}
            onChangeText={setMissionTitle}
          />

          <TextInput
            style={[styles.input, styles.textArea]}
            placeholder="Description (optional)"
            placeholderTextColor={colors.muted}
            value={missionDescription}
            onChangeText={setMissionDescription}
            multiline
            numberOfLines={3}
          />

          <TouchableOpacity
            style={styles.saveButton}
            onPress={handleSaveMission}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Save size={16} color="#FFFFFF" />
                <Text style={styles.saveButtonText}>Save Mission</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );

  // Render delete confirmation
  const renderDeleteConfirm = () => (
    <Modal
      visible={showDeleteConfirm}
      transparent
      animationType="fade"
      onRequestClose={() => setShowDeleteConfirm(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.confirmModal}>
          <Text style={styles.confirmTitle}>Delete Goal?</Text>
          <Text style={styles.confirmMessage}>
            Are you sure you want to delete "{deletingGoal?.title}"? This will also delete all sub-goals.
          </Text>
          <View style={styles.confirmActions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setShowDeleteConfirm(false)}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={handleDeleteGoal}
            >
              <Text style={styles.deleteButtonText}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      {renderToolbar()}

      <View style={styles.mainContent}>
        <GestureDetector gesture={composedGesture}>
          <Animated.View style={[styles.canvas, selectedGoal && styles.canvasWithPanel]}>
            <Animated.View
              style={[
                styles.canvasContent,
                { width: canvasSize.width, height: canvasSize.height },
                animatedCanvasStyle,
              ]}
            >
              {/* SVG connections */}
              <Svg
                style={StyleSheet.absoluteFill}
                width={canvasSize.width}
                height={canvasSize.height}
              >
                {renderConnections()}
              </Svg>

              {/* Mission card */}
              {renderMissionCard()}

              {/* Goal cards */}
              {goalsData.goals.filter(Boolean).map(renderGoalCard)}
            </Animated.View>
          </Animated.View>
        </GestureDetector>

        {/* Detail Panel */}
        {selectedGoal && (
          <DetailPanel
            item={{
              id: selectedGoal.id,
              title: selectedGoal.title,
              description: selectedGoal.description,
              status: selectedGoal.status,
              priority: selectedGoal.priority,
              timeframe: selectedGoal.timeframe,
              owner: selectedGoal.owner,
              progress: selectedGoal.progress,
              subgoalsCount: selectedGoal.subgoalsCount,
              completedSubgoals: selectedGoal.completedSubgoals,
            }}
            workspaceName={goalsData.mission?.title || 'My workspace'}
            subItems={getSubItemsForPanel()}
            subItemsLabel="Subgoals"
            onClose={() => setSelectedGoal(null)}
            onSubItemPress={(subItem) => {
              const goal = goalsData.goals.find(g => g.id === subItem.id);
              if (goal) setSelectedGoal(goal);
            }}
            onAddSubItem={() => handleCreateGoal(selectedGoal.id)}
            showCheckbox={true}
          />
        )}
      </View>

      {/* Pull to refresh overlay */}
      {refreshing && (
        <View style={styles.refreshOverlay}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      )}

      {/* Modals */}
      {renderGoalModal()}
      {renderMissionModal()}
      {renderDeleteConfirm()}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  toolbarLeft: {
    flexDirection: 'row',
    gap: 8,
  },
  toolbarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toolbarButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  toolbarButtonText: {
    fontSize: 13,
    color: colors.text,
    fontWeight: '500',
  },
  zoomButton: {
    width: 28,
    height: 28,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomText: {
    fontSize: 13,
    color: colors.muted,
    minWidth: 40,
    textAlign: 'center',
  },
  toolbarDivider: {
    width: 1,
    height: 20,
    backgroundColor: colors.border,
    marginHorizontal: 8,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#111827',
    gap: 6,
  },
  createButtonText: {
    fontSize: 13,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  mainContent: {
    flex: 1,
    flexDirection: 'row',
  },
  canvas: {
    flex: 1,
    overflow: 'hidden',
  },
  canvasWithPanel: {
    flex: 0.65,
  },
  canvasContent: {
    minWidth: '100%',
    minHeight: '100%',
  },
  refreshOverlay: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  // Mission card
  missionCard: {
    position: 'absolute',
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  missionLabel: {
    fontSize: 12,
    color: colors.muted,
    marginBottom: 4,
  },
  missionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    textAlign: 'center',
  },
  // Goal card
  goalCard: {
    position: 'absolute',
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  goalCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  avatarBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#8B5CF6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  goalTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },
  subgoalsText: {
    fontSize: 12,
    color: colors.muted,
    marginBottom: 8,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  progressBar: {
    flex: 1,
    height: 4,
    backgroundColor: colors.subtle,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#22C55E',
    borderRadius: 2,
  },
  progressText: {
    fontSize: 11,
    color: colors.muted,
    minWidth: 28,
    textAlign: 'right',
  },
  goalCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timeframeText: {
    fontSize: 11,
    color: colors.muted,
  },
  tasksCount: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  tasksCountText: {
    fontSize: 11,
    color: colors.muted,
  },
  expandButtonContainer: {
    position: 'absolute',
    bottom: -12,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  expandButton: {
    width: 24,
    height: 24,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 12,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    width: '100%',
    maxWidth: 425,
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
  },
  input: {
    height: 44,
    backgroundColor: colors.subtle,
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 15,
    color: colors.text,
    marginBottom: 12,
  },
  textArea: {
    height: 80,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
    marginTop: 8,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  // Shadcn sheet styles
  sheetContent: {
    width: '100%',
    maxWidth: 425,
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 24,
    paddingBottom: 0,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.5,
  },
  sheetDescription: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 4,
    lineHeight: 20,
  },
  sheetCloseButton: {
    width: 28,
    height: 28,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sheetBody: {
    padding: 24,
    gap: 16,
  },
  sheetFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    padding: 24,
    paddingTop: 0,
  },
  formField: {
    gap: 8,
  },
  formLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  formInput: {
    height: 40,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    fontSize: 14,
    color: colors.text,
  },
  formTextArea: {
    height: 80,
    paddingTop: 10,
    paddingBottom: 10,
    textAlignVertical: 'top',
  },
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    gap: 8,
  },
  statusChipSelected: {
    borderColor: colors.primary,
    backgroundColor: '#EFF6FF',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusChipText: {
    fontSize: 13,
    color: colors.muted,
    fontWeight: '500',
  },
  statusChipTextSelected: {
    color: colors.text,
  },
  sheetCancelButton: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sheetCancelButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  sheetPrimaryButton: {
    height: 40,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: '#18181B',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sheetPrimaryButtonDisabled: {
    opacity: 0.5,
  },
  sheetPrimaryButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  confirmModal: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 24,
  },
  confirmTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 12,
  },
  confirmMessage: {
    fontSize: 14,
    color: colors.muted,
    lineHeight: 20,
    marginBottom: 24,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: colors.subtle,
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  deleteButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#EF4444',
  },
  deleteButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
