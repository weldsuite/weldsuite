import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Modal,
  useWindowDimensions,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import {
  ChevronLeft,
  Sparkles,
  AlertCircle,
  GitBranch,
  FileText,
  LayoutTemplate,
  Plus,
  Mail,
  MessageSquare,
  Bell,
  PlusCircle,
  Pencil,
  Trash2,
  Search,
  Variable,
  Shuffle,
  GitFork,
  Repeat,
  Clock,
  Globe,
  Code,
  X,
  Menu,
  ChevronRight,
  Settings,
} from 'lucide-react-native';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';

// Responsive breakpoint
const TABLET_MIN_WIDTH = 768;

type TabType = 'editor' | 'runs' | 'settings';

const GRID_SIZE = 24;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const CANVAS_SIZE = 1500;

// Step type definition
interface StepType {
  id: string;
  name: string;
  description: string;
  icon: React.ComponentType<any>;
  category: string;
}

// Workflow step (added to canvas)
interface WorkflowStep {
  id: string;
  type: StepType;
  config: Record<string, any>;
}

// Define all available step types
const STEP_TYPES: StepType[] = [
  // Communication
  { id: 'send_email', name: 'Send Email', description: 'Send an email message', icon: Mail, category: 'Communication' },
  { id: 'slack_message', name: 'Slack Message', description: 'Send a Slack message', icon: MessageSquare, category: 'Communication' },
  { id: 'notification', name: 'Send Notification', description: 'Send an in-app notification', icon: Bell, category: 'Communication' },
  // Data
  { id: 'create_record', name: 'Create Record', description: 'Create a new database record', icon: PlusCircle, category: 'Data' },
  { id: 'update_record', name: 'Update Record', description: 'Update an existing record', icon: Pencil, category: 'Data' },
  { id: 'delete_record', name: 'Delete Record', description: 'Delete a record', icon: Trash2, category: 'Data' },
  { id: 'query_data', name: 'Query Data', description: 'Search and filter records', icon: Search, category: 'Data' },
  { id: 'set_variable', name: 'Set Variable', description: 'Store a value for later use', icon: Variable, category: 'Data' },
  { id: 'transform_data', name: 'Transform Data', description: 'Transform and map data', icon: Shuffle, category: 'Data' },
  // Logic & Flow
  { id: 'condition', name: 'Condition', description: 'Branch based on a condition', icon: GitFork, category: 'Logic & Flow' },
  { id: 'loop', name: 'Loop', description: 'Repeat actions for each item', icon: Repeat, category: 'Logic & Flow' },
  { id: 'delay', name: 'Delay', description: 'Wait for a specified time', icon: Clock, category: 'Logic & Flow' },
  // Integration
  { id: 'http_request', name: 'HTTP Request', description: 'Make an API request', icon: Globe, category: 'Integration' },
  { id: 'run_script', name: 'Run Script', description: 'Execute custom JavaScript', icon: Code, category: 'Integration' },
  // AI steps (ai_generate / ai_extract / ai_summarize) have been removed
  // along with the AI backend — they are no longer offered in the picker.
];

// Group steps by category
const STEP_CATEGORIES = ['Communication', 'Data', 'Logic & Flow', 'Integration'];

export default function WorkflowEditorPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<TabType>('editor');
  const [workflowName] = useState('erf');
  const [description, setDescription] = useState('');
  const [showAddStepMenu, setShowAddStepMenu] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const [selectedStep, setSelectedStep] = useState<WorkflowStep | null>(null);

  const isTablet = windowWidth >= TABLET_MIN_WIDTH;

  // Handle adding a new step to the workflow
  const handleAddStepType = (stepType: StepType) => {
    const newStep: WorkflowStep = {
      id: `step_${Date.now()}`,
      type: stepType,
      config: {},
    };
    setWorkflowSteps([...workflowSteps, newStep]);
    setSelectedStep(newStep);
    setShowAddStepMenu(false);
    if (!isTablet) {
      // Keep sidebar open to show step config
    }
  };

  // Handle selecting an existing step
  const handleSelectStep = (step: WorkflowStep) => {
    setSelectedStep(step);
    setShowAddStepMenu(false);
    if (!isTablet) {
      setShowSidebar(true);
    }
  };

  // Handle deleting a step
  const handleDeleteStep = (stepId: string) => {
    Alert.alert('Delete Step', 'Are you sure you want to delete this step?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setWorkflowSteps(workflowSteps.filter(s => s.id !== stepId));
          if (selectedStep?.id === stepId) {
            setSelectedStep(null);
          }
        },
      },
    ]);
  };

  // Canvas state with reanimated shared values
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  // Pinch gesture for zooming
  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      savedScale.value = scale.value;
    })
    .onUpdate((event) => {
      const newScale = savedScale.value * event.scale;
      scale.value = Math.min(Math.max(newScale, MIN_ZOOM), MAX_ZOOM);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  // Pan gesture for moving
  const panGesture = Gesture.Pan()
    .onStart(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onUpdate((event) => {
      translateX.value = savedTranslateX.value + event.translationX;
      translateY.value = savedTranslateY.value + event.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  // Combine gestures
  const composedGesture = Gesture.Simultaneous(pinchGesture, panGesture);

  // Animated style for canvas content
  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { scale: scale.value },
      ],
    };
  });

  const tabs: { key: TabType; label: string }[] = [
    { key: 'editor', label: 'Editor' },
    { key: 'runs', label: 'Runs' },
    { key: 'settings', label: 'Settings' },
  ];

  // Memoized grid dots
  const gridDots = useMemo(() => {
    const dots = [];
    const cols = Math.ceil(CANVAS_SIZE / GRID_SIZE) + 1;
    const rows = Math.ceil(CANVAS_SIZE / GRID_SIZE) + 1;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        dots.push(
          <View
            key={`${row}-${col}`}
            style={[
              styles.gridDot,
              {
                left: col * GRID_SIZE,
                top: row * GRID_SIZE,
              },
            ]}
          />
        );
      }
    }

    return dots;
  }, []);

  const handleAddStep = () => {
    setShowAddStepMenu(true);
    if (!isTablet) {
      setShowSidebar(true);
    }
  };

  // Render step configuration panel
  const renderStepConfig = () => {
    if (!selectedStep) return null;
    const StepIcon = selectedStep.type.icon;

    return (
      <>
        {/* Step Config Header */}
        <View style={styles.stepConfigHeader}>
          <View style={styles.stepConfigTitleRow}>
            <View style={[styles.stepIconWrapper, { backgroundColor: '#EEF2FF' }]}>
              <StepIcon size={20} color="#6366F1" strokeWidth={1.5} />
            </View>
            <View style={styles.stepConfigTitleContent}>
              <Text style={[styles.stepConfigTitle, { color: colors.text }]}>{selectedStep.type.name}</Text>
              <Text style={[styles.stepConfigSubtitle, { color: colors.muted }]}>{selectedStep.type.description}</Text>
            </View>
          </View>
          {!isTablet && (
            <TouchableOpacity
              style={styles.closeSidebarButton}
              onPress={() => {
                setShowSidebar(false);
                setSelectedStep(null);
              }}
            >
              <X size={20} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
          )}
        </View>
        <View style={[styles.addStepDivider, { backgroundColor: colors.border }]} />

        {/* Configuration Section */}
        <View style={styles.configSection}>
          <Text style={[styles.configSectionTitle, { color: colors.text }]}>Configuration</Text>
          <Text style={[styles.configSectionSubtitle, { color: colors.muted }]}>
            Configure this step's behavior
          </Text>

          {/* Placeholder for step-specific config */}
          <View style={[styles.configPlaceholder, { borderColor: colors.border }]}>
            <Settings size={24} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.configPlaceholderText, { color: colors.muted }]}>
              Step configuration options will appear here
            </Text>
          </View>
        </View>

        {/* Delete Button */}
        <TouchableOpacity
          style={styles.deleteStepButton}
          onPress={() => handleDeleteStep(selectedStep.id)}
        >
          <Trash2 size={16} color="#EF4444" strokeWidth={2} />
          <Text style={styles.deleteStepButtonText}>Delete Step</Text>
        </TouchableOpacity>
      </>
    );
  };

  // Sidebar content component (used in both modal and panel)
  const renderSidebarContent = () => (
    <ScrollView style={styles.sidebarContent} showsVerticalScrollIndicator={false}>
      {showAddStepMenu ? (
        <>
          {/* Add Step Header */}
          <View style={styles.addStepHeader}>
            <Plus size={18} color="#22C55E" strokeWidth={2.5} />
            <Text style={styles.addStepTitle}>Add Step</Text>
            {!isTablet && (
              <TouchableOpacity
                style={styles.closeSidebarButton}
                onPress={() => {
                  setShowSidebar(false);
                  setShowAddStepMenu(false);
                }}
              >
                <X size={20} color="#6B7280" strokeWidth={2} />
              </TouchableOpacity>
            )}
          </View>
          <View style={[styles.addStepDivider, { backgroundColor: colors.border }]} />

          {/* Render step categories */}
          {STEP_CATEGORIES.map((category) => (
            <View key={category}>
              <Text style={styles.stepCategoryTitle}>{category}</Text>
              {STEP_TYPES.filter(step => step.category === category).map((stepType) => {
                const StepIcon = stepType.icon;
                return (
                  <TouchableOpacity
                    key={stepType.id}
                    style={styles.stepItem}
                    onPress={() => handleAddStepType(stepType)}
                  >
                    <View style={styles.stepIconWrapper}>
                      <StepIcon size={20} color="#6B7280" strokeWidth={1.5} />
                    </View>
                    <View style={styles.stepItemContent}>
                      <Text style={styles.stepItemTitle}>{stepType.name}</Text>
                      <Text style={styles.stepItemSubtitle}>{stepType.description}</Text>
                    </View>
                    <ChevronRight size={16} color="#9CA3AF" />
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </>
      ) : selectedStep ? (
        renderStepConfig()
      ) : (
        <>
          {/* Workflow Info Header for phone */}
          {!isTablet && (
            <View style={styles.sidebarHeader}>
              <Text style={[styles.sidebarHeaderTitle, { color: colors.text }]}>Workflow Info</Text>
              <TouchableOpacity
                style={styles.closeSidebarButton}
                onPress={() => setShowSidebar(false)}
              >
                <X size={20} color="#6B7280" strokeWidth={2} />
              </TouchableOpacity>
            </View>
          )}

          {/* Workflow Info */}
          <View style={styles.workflowInfo}>
            <View style={styles.workflowHeader}>
              <View style={styles.workflowIcon}>
                <GitBranch size={16} color="#6B7280" strokeWidth={2} />
              </View>
              <Text style={[styles.workflowName, { color: colors.text }]}>
                {workflowName}
              </Text>
            </View>
            <TextInput
              style={[styles.descriptionInput, { color: colors.muted }]}
              placeholder="Add a description..."
              placeholderTextColor="#9CA3AF"
              value={description}
              onChangeText={setDescription}
              multiline
            />
          </View>

          {/* Workflow Steps List */}
          {workflowSteps.length > 0 && (
            <View style={styles.stepsListSection}>
              <Text style={[styles.checklistTitle, { color: colors.text }]}>Steps ({workflowSteps.length})</Text>
              {workflowSteps.map((step, index) => {
                const StepIcon = step.type.icon;
                return (
                  <TouchableOpacity
                    key={step.id}
                    style={[styles.stepListItem, { borderColor: colors.border }]}
                    onPress={() => handleSelectStep(step)}
                  >
                    <View style={[styles.stepListNumber, { backgroundColor: '#EEF2FF' }]}>
                      <Text style={styles.stepListNumberText}>{index + 1}</Text>
                    </View>
                    <View style={styles.stepListContent}>
                      <Text style={[styles.stepListTitle, { color: colors.text }]}>{step.type.name}</Text>
                    </View>
                    <ChevronRight size={16} color="#9CA3AF" />
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Checklist */}
          <View style={styles.checklistSection}>
            <Text style={[styles.checklistTitle, { color: colors.text }]}>Checklist</Text>
            <Text style={[styles.checklistSubtitle, { color: colors.muted }]}>
              Make sure all issues are resolved before publishing
            </Text>

            <View style={[styles.checklistItem, { borderColor: colors.border }]}>
              <View style={styles.checklistItemLeft}>
                <Sparkles size={16} color="#6B7280" strokeWidth={2} />
                <Text style={[styles.checklistItemText, { color: colors.text }]}>
                  Select Trigger
                </Text>
              </View>
              <View style={styles.checklistItemBadge}>
                <Text style={styles.checklistItemBadgeText}>Trigger</Text>
              </View>
            </View>

            {workflowSteps.length === 0 && (
              <View style={styles.warningMessage}>
                <AlertCircle size={14} color="#F59E0B" strokeWidth={2} />
                <Text style={styles.warningText}>
                  Add at least one step to your workflow
                </Text>
              </View>
            )}
          </View>

          {/* Helpful Resources */}
          <View style={styles.resourcesSection}>
            <Text style={[styles.resourcesTitle, { color: colors.muted }]}>
              Helpful resources
            </Text>
            <View style={styles.resourceCards}>
              <TouchableOpacity style={[styles.resourceCard, { borderColor: colors.border }]}>
                <FileText size={18} color="#6B7280" strokeWidth={2} />
                <View style={styles.resourceCardContent}>
                  <Text style={[styles.resourceCardTitle, { color: colors.text }]}>
                    Documentation
                  </Text>
                  <Text style={[styles.resourceCardSubtitle, { color: colors.muted }]}>
                    Learn how to setup workflows
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.resourceCard, { borderColor: colors.border }]}>
                <LayoutTemplate size={18} color="#6B7280" strokeWidth={2} />
                <View style={styles.resourceCardContent}>
                  <Text style={[styles.resourceCardTitle, { color: colors.text }]}>
                    Templates
                  </Text>
                  <Text style={[styles.resourceCardSubtitle, { color: colors.muted }]}>
                    Use ready-made templates
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: insets.top + 12 }]}>
          <View style={styles.headerLeft}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => router.back()}
            >
              <ChevronLeft size={20} color="#374151" strokeWidth={2} />
            </TouchableOpacity>
            {isTablet && (
              <View style={styles.tabs}>
                {tabs.map((tab, index) => (
                  <TouchableOpacity
                    key={tab.key}
                    style={[
                      styles.tab,
                      activeTab === tab.key && styles.tabActive,
                      index === tabs.length - 1 && styles.tabLast,
                    ]}
                    onPress={() => setActiveTab(tab.key)}
                  >
                    <Text
                      style={[
                        styles.tabText,
                        activeTab === tab.key && styles.tabTextActive,
                      ]}
                    >
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {!isTablet && (
              <Text style={[styles.headerTitle, { color: colors.text }]}>{workflowName}</Text>
            )}
          </View>
          <View style={styles.headerRight}>
            {isTablet ? (
              <>
                <View style={styles.textButtonGroup}>
                  <TouchableOpacity style={styles.textButton}>
                    <Text style={styles.textButtonText}>Test</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.textButton, styles.textButtonLast]}>
                    <Text style={styles.textButtonText}>Save</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity style={styles.publishButton}>
                  <Text style={styles.publishButtonText}>Publish</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.headerIconButton}
                  onPress={() => setShowSidebar(true)}
                >
                  <Menu size={20} color="#374151" strokeWidth={2} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.publishButtonSmall}>
                  <Text style={styles.publishButtonText}>Publish</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* Phone tabs below header */}
        {!isTablet && (
          <View style={[styles.phoneTabs, { borderBottomColor: colors.border }]}>
            {tabs.map((tab) => (
              <TouchableOpacity
                key={tab.key}
                style={[
                  styles.phoneTab,
                  activeTab === tab.key && styles.phoneTabActive,
                ]}
                onPress={() => setActiveTab(tab.key)}
              >
                <Text
                  style={[
                    styles.phoneTabText,
                    activeTab === tab.key && styles.phoneTabTextActive,
                  ]}
                >
                  {tab.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Main Content */}
        <View style={styles.mainContent}>
          {/* Canvas Area */}
          <View style={styles.canvasContainer}>
            <GestureDetector gesture={composedGesture}>
              <View style={styles.canvas}>
                <Animated.View style={[styles.canvasContent, { width: CANVAS_SIZE, height: CANVAS_SIZE }, animatedStyle]}>
                  {/* Grid Background */}
                  <View style={styles.gridContainer}>
                    {gridDots}
                  </View>

                  {/* Trigger Node */}
                  <View style={styles.triggerNodeContainer}>
                    <View style={[styles.triggerNode, { borderColor: colors.border, width: isTablet ? 280 : 260 }]}>
                      <View style={styles.triggerNodeHeader}>
                        <View style={styles.triggerNodeLeft}>
                          <View style={styles.triggerIconBg}>
                            <Sparkles size={16} color="#F59E0B" strokeWidth={2} />
                          </View>
                          <Text style={styles.triggerNodeTitleText}>Select Trigger</Text>
                        </View>
                        <View style={styles.triggerNodeRight}>
                          <AlertCircle size={18} color="#F59E0B" strokeWidth={1.5} />
                          <View style={styles.triggerBadge}>
                            <Text style={styles.triggerBadgeText}>Trigger</Text>
                          </View>
                        </View>
                      </View>
                      <View style={styles.triggerDivider} />
                      <Text style={[styles.triggerNodeSubtext, { color: colors.muted }]}>
                        Click to configure
                      </Text>
                    </View>
                    {/* Connector */}
                    <View style={styles.connectorLine} />
                    <TouchableOpacity
                      style={styles.addNodeButton}
                      onPress={handleAddStep}
                    >
                      <Plus size={12} color="#111827" strokeWidth={2.5} />
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              </View>
            </GestureDetector>
          </View>

          {/* Right Sidebar - only on tablet */}
          {isTablet && (
            <View style={[styles.sidebar, { borderLeftColor: colors.border }]}>
              {renderSidebarContent()}
            </View>
          )}
        </View>

        {/* Bottom Sheet Modal for phone */}
        <Modal
          visible={showSidebar && !isTablet}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => {
            setShowSidebar(false);
            setShowAddStepMenu(false);
          }}
        >
          <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
            {renderSidebarContent()}
          </View>
        </Modal>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    backgroundColor: '#FFFFFF',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  tabs: {
    flexDirection: 'row',
    gap: 0,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    overflow: 'hidden',
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRightWidth: 1,
    borderRightColor: '#E5E7EB',
  },
  tabLast: {
    borderRightWidth: 0,
  },
  tabActive: {
    backgroundColor: '#F3F4F6',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6B7280',
  },
  tabTextActive: {
    color: '#111827',
  },
  phoneTabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    backgroundColor: '#FFFFFF',
  },
  phoneTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  phoneTabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#111827',
  },
  phoneTabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6B7280',
  },
  phoneTabTextActive: {
    color: '#111827',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerIconButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  textButtonGroup: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    overflow: 'hidden',
  },
  textButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRightWidth: 1,
    borderRightColor: '#E5E7EB',
  },
  textButtonLast: {
    borderRightWidth: 0,
  },
  textButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  publishButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#111827',
  },
  publishButtonSmall: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#111827',
  },
  publishButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  mainContent: {
    flex: 1,
    flexDirection: 'row',
  },
  canvasContainer: {
    flex: 1,
    backgroundColor: '#FAFAFA',
    overflow: 'hidden',
  },
  canvas: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  canvasContent: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  gridContainer: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
  },
  gridDot: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#D1D5DB',
  },
  triggerNodeContainer: {
    alignItems: 'center',
  },
  triggerNode: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  triggerNodeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  triggerNodeLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  triggerIconBg: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#FEF3C7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  triggerNodeRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  triggerNodeTitleText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  triggerBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  triggerBadgeText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#6B7280',
  },
  triggerDivider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginHorizontal: 16,
  },
  triggerNodeSubtext: {
    fontSize: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  connectorLine: {
    width: 0,
    height: 0,
  },
  addNodeButton: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
    marginTop: -10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sidebar: {
    width: 320,
    borderLeftWidth: 1,
    backgroundColor: '#FFFFFF',
  },
  sidebarContent: {
    flex: 1,
    padding: 20,
  },
  sidebarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sidebarHeaderTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  closeSidebarButton: {
    padding: 4,
    marginLeft: 'auto',
  },
  modalContainer: {
    flex: 1,
    paddingTop: 12,
  },
  workflowInfo: {
    marginBottom: 24,
  },
  workflowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  workflowIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  workflowName: {
    fontSize: 16,
    fontWeight: '600',
  },
  descriptionInput: {
    fontSize: 14,
    padding: 0,
  },
  checklistSection: {
    marginBottom: 24,
  },
  checklistTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  checklistSubtitle: {
    fontSize: 13,
    marginBottom: 16,
  },
  checklistItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  checklistItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  checklistItemText: {
    fontSize: 14,
    fontWeight: '500',
  },
  checklistItemBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: '#F3F4F6',
  },
  checklistItemBadgeText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#6B7280',
  },
  warningMessage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  warningText: {
    fontSize: 13,
    color: '#F59E0B',
  },
  resourcesSection: {
    marginTop: 'auto',
  },
  resourcesTitle: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 12,
  },
  resourceCards: {
    flexDirection: 'row',
    gap: 12,
  },
  resourceCard: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
  },
  resourceCardContent: {
    gap: 2,
  },
  resourceCardTitle: {
    fontSize: 13,
    fontWeight: '500',
  },
  resourceCardSubtitle: {
    fontSize: 11,
  },
  addStepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 16,
  },
  addStepTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  addStepDivider: {
    height: 1,
    marginBottom: 8,
  },
  stepCategoryTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#22C55E',
    marginTop: 16,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  stepIconWrapper: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepItemContent: {
    flex: 1,
  },
  stepItemTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
    marginBottom: 2,
  },
  stepItemSubtitle: {
    fontSize: 12,
    color: '#6B7280',
  },
  // Step config styles
  stepConfigHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 16,
  },
  stepConfigTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  stepConfigTitleContent: {
    flex: 1,
  },
  stepConfigTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  stepConfigSubtitle: {
    fontSize: 13,
  },
  configSection: {
    marginTop: 16,
  },
  configSectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  configSectionSubtitle: {
    fontSize: 13,
    marginBottom: 16,
  },
  configPlaceholder: {
    padding: 24,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    gap: 12,
  },
  configPlaceholderText: {
    fontSize: 14,
    textAlign: 'center',
  },
  deleteStepButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 24,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#FEE2E2',
  },
  deleteStepButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#EF4444',
  },
  // Steps list styles
  stepsListSection: {
    marginBottom: 24,
  },
  stepListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    gap: 12,
  },
  stepListNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepListNumberText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6366F1',
  },
  stepListContent: {
    flex: 1,
  },
  stepListTitle: {
    fontSize: 14,
    fontWeight: '500',
  },
});
