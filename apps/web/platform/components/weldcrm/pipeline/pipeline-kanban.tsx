
import { useState, useEffect, useMemo, useTransition, startTransition, useRef, lazy, Suspense } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  getFirstCollision,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { DealCard } from './deal-card';
import { DealDetailsModal } from './deal-details-modal';
import { EditDealModal } from './edit-deal-modal';
import { useObjectPanel } from '@/components/object-panel';
// Lazy: the panel's own tree reaches back into CRM components (deals ->
// pipeline), so a static import here closes an import cycle. Lazy keeps the
// recursion at runtime only.
const CustomerDetailPanel = lazy(() =>
  import('@/app/weldmail/components/customer-detail-panel').then((m) => ({ default: m.CustomerDetailPanel })),
);
import { AddStagePopover } from './add-stage-modal';
import { DroppableStage } from './droppable-stage';
import { SortableStage, useSortableStage } from './sortable-stage';
import { StageHeader } from './stage-header';
import { FilterPills } from '@/components/entity-list';
import type { FilterConfig, ActiveFilter } from '@/components/entity-list';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useCreatePipelineStage } from '@/hooks/queries/use-pipelines-queries';
import { useUpdateOpportunity, useDeleteOpportunity } from '@/hooks/queries/use-opportunities-queries';
import { type PipelineViewSettings, DEFAULT_PIPELINE_SETTINGS } from '@/app/weldcrm/pipeline/pipeline-settings-types';
// import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  FileText,
  Filter,
  GripVertical,
  LayoutGrid,
  LayoutList,
  Pencil,
  Plus,
  Search,
  Settings,
  Sparkles,
  Target,
  Trash2,
  Users,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@weldsuite/ui/components/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Calculator,
  TrendingUp,
  Percent,
  DollarSign,
  BarChart3,
  PieChart
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';

interface Deal {
  id: string;
  title: string;
  value: number;
  currency?: string;
  stage: string;
  company?: {
    id: string;
    name: string;
    logoUrl?: string;
  };
  contact?: {
    id: string;
    name: string;
    email?: string;
    avatarUrl?: string;
  };
  owner?: {
    id: string;
    name: string;
    email?: string;
    avatarUrl?: string;
  };
  probability?: number;
  expectedCloseDate?: Date | string;
  lastActivity?: Date | string;
  tags?: string[];
}

interface Stage {
  id: string;
  name: string;
  color?: string;
  deals: Deal[];
  value: number;
  count: number;
  probability?: number;
}

interface PipelineKanbanProps {
  initialDeals?: Deal[];
  initialStages?: any[];
  workspaceId: string;
  customers?: any[];
  contacts?: any[];
  onDealMove?: (dealId: string, fromStage: string, toStage: string) => void;
  onDealCreate?: (data: any) => Promise<void>;
  pipelineId?: string;
  pipelineName?: string;
  initialSettings?: PipelineViewSettings;
  lockedCustomer?: { id: string; name: string };
  hideHeader?: boolean;
}

const DEFAULT_STAGES: Omit<Stage, 'deals' | 'value' | 'count'>[] = [
  { id: 'prospecting', name: 'Prospecting', color: 'bg-gray-500', probability: 10 },
  { id: 'qualification', name: 'Qualified', color: 'bg-blue-500', probability: 25 },
  { id: 'proposal', name: 'Proposal', color: 'bg-yellow-500', probability: 50 },
  { id: 'negotiation', name: 'Negotiation', color: 'bg-orange-500', probability: 75 },
  { id: 'closed_won', name: 'Closed Won', color: 'bg-green-500', probability: 100 },
  { id: 'closed_lost', name: 'Closed Lost', color: 'bg-red-500', probability: 0 },
];

export function PipelineKanban({
  initialDeals = [],
  initialStages = [],
  workspaceId,
  customers = [],
  contacts = [],
  onDealMove,
  onDealCreate,
  pipelineId,
  pipelineName,
  initialSettings = DEFAULT_PIPELINE_SETTINGS,
  lockedCustomer,
  hideHeader,
}: PipelineKanbanProps) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const createStageMutation = useCreatePipelineStage();
  const updateOpportunityMutation = useUpdateOpportunity();
  const deleteOpportunityMutation = useDeleteOpportunity();
  const [stages, setStages] = useState<Stage[]>([]);
  const [activeDealId, setActiveDealId] = useState<string | null>(null);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('kanban');
  const [showDealDetails, setShowDealDetails] = useState(false);
  const [showEditDeal, setShowEditDeal] = useState(false);
  const [selectedDealForEdit, setSelectedDealForEdit] = useState<Deal | null>(null);
  const { open: openObjectPanel } = useObjectPanel();
  const [showAddStage, setShowAddStage] = useState(false);
  const [selectedStageForNewDeal, setSelectedStageForNewDeal] = useState<string | null>(null);
  const [stageCalculations, setStageCalculations] = useState<Record<string, { type: string; value: string | number }>>({});
  const [showCustomFormulaModal, setShowCustomFormulaModal] = useState(false);
  const [selectedStageForFormula, setSelectedStageForFormula] = useState<string | null>(null);
  const [showPipelineSettings, setShowPipelineSettings] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<{ id: string; email?: string; name?: string; company?: string; phone?: string } | null>(null);
  const [customDealFields, setCustomDealFields] = useState(() => {
    // Initialize from viewSettings if available, otherwise use empty array
    if (initialSettings.customFields && initialSettings.customFields.length > 0) {
      return initialSettings.customFields;
    }
    return [];
  });
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [confettiStages, setConfettiStages] = useState<Set<string>>(new Set());
  const handleConfettiChange = (stageId: string, enabled: boolean) => {
    setConfettiStages(prev => {
      const next = new Set(prev);
      if (enabled) {
        next.add(stageId);
      } else {
        next.delete(stageId);
      }
      return next;
    });
  };

  const fireConfetti = async () => {
    const confetti = (await import('canvas-confetti')).default;

    const colors = ['#f43f5e', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#ec4899', '#f97316', '#06b6d4', '#10b981', '#6366f1'];

    // Instant big burst â€” wall of confetti raining down from the entire top
    // angle: 270 = downward (0=right, 90=up, 180=left, 270=down)
    for (let x = 0; x <= 1; x += 0.07) {
      confetti({
        particleCount: 35,
        spread: 130,
        angle: 270,
        origin: { x, y: 0 },
        colors,
        startVelocity: 30 + Math.random() * 15,
        gravity: 1.2,
        ticks: 100,
        scalar: 1.2,
        drift: (Math.random() - 0.5) * 2,
      });
    }

  };

  // Filter configs for the FilterPills component
  const pipelineFilterConfigs: FilterConfig[] = useMemo(() => [
    { field: 'stage', label: t('sweep.weldcrm.pipelineKanban.filterStage'), options: stages.map(s => ({ value: s.id, label: s.name })) },
    { field: 'value', label: t('sweep.weldcrm.pipelineKanban.filterValue'), options: [{ value: '0-1000', label: '< $1K' }, { value: '1000-10000', label: '$1K - $10K' }, { value: '10000-100000', label: '$10K - $100K' }, { value: '100000+', label: '$100K+' }] },
    { field: 'probability', label: t('sweep.weldcrm.pipelineKanban.filterProbability'), options: [{ value: '0-25', label: '0-25%' }, { value: '25-50', label: '25-50%' }, { value: '50-75', label: '50-75%' }, { value: '75-100', label: '75-100%' }] },
    { field: 'company', label: t('sweep.weldcrm.pipelineKanban.filterCompany'), options: customers.slice(0, 20).map((c: any) => ({ value: c.id, label: c.companyName || c.name || c.email })) },
  ], [stages, customers, t]);

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  // View settings state - initialized from props
  const [viewSettings, setViewSettings] = useState<PipelineViewSettings>(initialSettings);

  // Helper to update view settings and persist to database.
  //
  // Was `PUT /crm/pipelines/:id/settings`, which exists on NO worker — it 404'd
  // and the catch below swallowed it, so these settings were in-memory only and
  // reset on every reload. `PATCH /api/pipelines/:id` accepts `settings` and
  // writes it straight to the `crm_pipelines.settings` jsonb column, so it can
  // carry the whole `PipelineViewSettings` shape. Repointed there.
  //
  // Sends the merged `newSettings`, NOT the `updates` partial: `settings` is a
  // single jsonb column, so a partial would overwrite the column and drop every
  // field the caller didn't touch.
  //
  // Two consequences worth knowing, both inherent to the original design (these
  // settings live on the shared pipeline row, not per-user):
  //  - the settings are workspace-wide, so one user's change is everyone's;
  //  - the route is gated on `pipelines:update`, which MEMBER does not hold
  //    (it has `pipelines:read` only). Members get a 403 that the catch swallows,
  //    leaving them exactly where they are today — in-memory only.
  const updateViewSettings = async (updates: Partial<PipelineViewSettings>) => {
    const newSettings = { ...viewSettings, ...updates };
    setViewSettings(newSettings);

    // Persist to database if we have a pipelineId
    if (pipelineId) {
      try {
        const client = await getClient();
        await client.patch(`/pipelines/${pipelineId}`, { settings: newSettings });
      } catch (error) {
        console.error('Failed to save view settings:', error);
      }
    }
  };

  // Helper to toggle a visible attribute
  const toggleVisibleAttribute = async (attribute: keyof PipelineViewSettings['visibleAttributes']) => {
    const newVisibleAttributes = {
      ...viewSettings.visibleAttributes,
      [attribute]: !viewSettings.visibleAttributes[attribute],
    };
    await updateViewSettings({ visibleAttributes: newVisibleAttributes });
  };

  // Backward compatibility alias
  const showAttributeLabels = viewSettings.showAttributeLabels;
  const setShowAttributeLabels = (value: boolean) => updateViewSettings({ showAttributeLabels: value });

  const containerRef = useRef<HTMLDivElement>(null);
  const stagesScrollRef = useRef<HTMLDivElement>(null);
  const calculationScrollRef = useRef<HTMLDivElement>(null);
  const [calcBarBounds, setCalcBarBounds] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setCalcBarBounds({ left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const prevDealsKeyRef = useRef<string>('');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 3,
      },
    })
  );

  // Custom collision detection that prioritizes droppable stages
  const customCollisionDetection = (args: any) => {
    // First try to find collisions with stage containers
    const pointerCollisions = pointerWithin(args);
    const stageCollisions = pointerCollisions.filter((collision: any) =>
      collision.id?.toString().startsWith('stage-')
    );

    // If pointer is within a stage, use that
    if (stageCollisions.length > 0) {
      return stageCollisions;
    }

    // Otherwise use rectangle intersection for broader detection
    const rectCollisions = rectIntersection(args);
    const rectStageCollisions = rectCollisions.filter((collision: any) =>
      collision.id?.toString().startsWith('stage-')
    );

    if (rectStageCollisions.length > 0) {
      return rectStageCollisions;
    }

    // Fall back to any collision
    return rectCollisions;
  };

  // Create a stable key based on deal IDs and stages to detect actual changes
  const dealsKey = initialDeals.map(d => `${d.id}-${d.stage}`).join(',');
  const stagesKey = initialStages.map(s => s.id || s.name).join(',');

  useEffect(() => {
    // Only update if deals or stages actually changed
    const currentKey = `${dealsKey}|${stagesKey}`;
    if (prevDealsKeyRef.current === currentKey) {
      return;
    }

    prevDealsKeyRef.current = currentKey;

    // Use API stages if available, otherwise fall back to DEFAULT_STAGES
    const stageTemplates = initialStages.length > 0
      ? initialStages.map(s => ({
          id: s.id || s.name,
          name: s.name,
          color: s.color || 'bg-gray-500',
          probability: s.probability || 50,
        }))
      : DEFAULT_STAGES;

    // Initialize stages with deals
    const stageMap = new Map<string, Deal[]>();

    initialDeals.forEach(deal => {
      const stageDeals = stageMap.get(deal.stage) || [];
      stageDeals.push(deal);
      stageMap.set(deal.stage, stageDeals);
    });

    const populatedStages = stageTemplates.map(stage => {
      const deals = stageMap.get(stage.id) || [];
      const value = deals.reduce((sum, deal) => sum + deal.value, 0);
      return {
        ...stage,
        deals,
        value,
        count: deals.length,
      };
    });

    setStages(populatedStages);
  }, [dealsKey, stagesKey, initialDeals, initialStages]);

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const activeId = active.id as string;
    
    // Check if we're dragging a stage or a deal
    if (activeId.startsWith('sortable-stage-')) {
      const stageId = activeId.replace('sortable-stage-', '');
      setActiveStageId(stageId);
      setActiveDealId(null);
    } else {
      setActiveDealId(activeId);
      setActiveStageId(null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDealId(null);
    setActiveStageId(null);
    
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    // Handle stage reordering
    if (activeId.startsWith('sortable-stage-')) {
      const activeStageId = activeId.replace('sortable-stage-', '');
      let overStageId = overId;
      
      if (overId.startsWith('sortable-stage-')) {
        overStageId = overId.replace('sortable-stage-', '');
      } else if (overId.startsWith('stage-')) {
        overStageId = overId.replace('stage-', '');
      } else {
        // Over a deal, find its stage
        for (const stage of stages) {
          if (stage.deals.some(d => d.id === overId)) {
            overStageId = stage.id;
            break;
          }
        }
      }

      if (activeStageId !== overStageId) {
        setStages(prevStages => {
          const oldIndex = prevStages.findIndex(s => s.id === activeStageId);
          const newIndex = prevStages.findIndex(s => s.id === overStageId);
          
          if (oldIndex !== -1 && newIndex !== -1) {
            const newStages = [...prevStages];
            const [movedStage] = newStages.splice(oldIndex, 1);
            newStages.splice(newIndex, 0, movedStage);
            return newStages;
          }
          
          return prevStages;
        });
      }
      return;
    }

    // Handle deal movement (existing code)
    const activeDealId = activeId;

    // Find the deal and its current stage
    let fromStage: Stage | undefined;
    let deal: Deal | undefined;
    
    for (const stage of stages) {
      const foundDeal = stage.deals.find(d => d.id === activeDealId);
      if (foundDeal) {
        fromStage = stage;
        deal = foundDeal;
        break;
      }
    }

    if (!fromStage || !deal) return;

    // Find the target stage
    let toStage: Stage | undefined;
    
    if (overId.startsWith('stage-')) {
      const stageId = overId.replace('stage-', '');
      toStage = stages.find(s => s.id === stageId);
    } else if (overId.startsWith('sortable-stage-')) {
      const stageId = overId.replace('sortable-stage-', '');
      toStage = stages.find(s => s.id === stageId);
    } else {
      // We're over a deal, find its stage
      for (const stage of stages) {
        if (stage.deals.some(d => d.id === overId)) {
          toStage = stage;
          break;
        }
      }
    }

    if (toStage && fromStage.id !== toStage.id) {
      // Update local state immediately for smooth UX
      setStages(prevStages => {
        const newStages = [...prevStages];
        
        // Find indices
        const fromStageIndex = newStages.findIndex(s => s.id === fromStage.id);
        const toStageIndex = newStages.findIndex(s => s.id === toStage.id);
        
        if (fromStageIndex === -1 || toStageIndex === -1) {
          return prevStages;
        }
        
        // Find and remove deal from source stage
        const dealIndex = newStages[fromStageIndex].deals.findIndex(d => d.id === activeDealId);
        
        if (dealIndex === -1) {
          return prevStages;
        }
        
        const [movedDeal] = newStages[fromStageIndex].deals.splice(dealIndex, 1);
        
        if (!movedDeal) {
          return prevStages;
        }
        
        // Update source stage counts
        newStages[fromStageIndex].count -= 1;
        newStages[fromStageIndex].value -= movedDeal.value;
        
        // Add deal to target stage
        movedDeal.stage = toStage.id;
        newStages[toStageIndex].deals.push(movedDeal);
        
        // Update target stage counts
        newStages[toStageIndex].count += 1;
        newStages[toStageIndex].value += movedDeal.value;
        
        return newStages;
      });

      // Fire confetti if target stage has it enabled
      if (confettiStages.has(toStage.id)) {
        fireConfetti();
      }

      // Call server action to persist the change
      if (onDealMove) {
        // Update server state and refresh after a short delay to allow animation to complete
        Promise.resolve(onDealMove(activeDealId, fromStage.id, toStage.id))
          .then(() => {
          })
          .catch((error) => {
            console.error('Failed to move deal:', error);
            // Revert the optimistic update on error
            setStages(prevStages => {
              const newStages = [...prevStages];
              const fromIdx = newStages.findIndex(s => s.id === toStage.id);
              const toIdx = newStages.findIndex(s => s.id === fromStage.id);

              if (fromIdx !== -1 && toIdx !== -1) {
                const dealIdx = newStages[fromIdx].deals.findIndex(d => d.id === activeDealId);
                if (dealIdx !== -1) {
                  const [movedDeal] = newStages[fromIdx].deals.splice(dealIdx, 1);
                  movedDeal.stage = fromStage.id;
                  newStages[toIdx].deals.push(movedDeal);

                  newStages[fromIdx].count -= 1;
                  newStages[fromIdx].value -= movedDeal.value;
                  newStages[toIdx].count += 1;
                  newStages[toIdx].value += movedDeal.value;
                }
              }

              return newStages;
            });
          });
      }
    }
  };

  const activeDeal = activeDealId
    ? stages.flatMap(s => s.deals).find(d => d.id === activeDealId)
    : null;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
      notation: amount >= 1000000 ? 'compact' : 'standard',
    }).format(amount);
  };

  const handleCalculation = (stageId: string, calculationType: string) => {
    const stage = stages.find(s => s.id === stageId);
    if (!stage) return;

    let calculatedValue: string | number = '';

    switch (calculationType) {
      case 'total':
        calculatedValue = formatCurrency(stage.value);
        break;
      case 'average':
        const avgValue = stage.count > 0 ? stage.value / stage.count : 0;
        calculatedValue = formatCurrency(avgValue);
        break;
      case 'winRate':
        // Calculate win rate based on stage probability
        calculatedValue = `${stage.probability || 0}%`;
        break;
      case 'weighted':
        const weightedVal = stage.value * (stage.probability || 0) / 100;
        calculatedValue = formatCurrency(weightedVal);
        break;
      case 'distribution':
        const totalPipelineValue = stages.reduce((sum, s) => sum + s.value, 0);
        const percentage = totalPipelineValue > 0 ? (stage.value / totalPipelineValue) * 100 : 0;
        calculatedValue = `${percentage.toFixed(1)}%`;
        break;
      case 'custom':
        // Open custom formula modal instead of setting a value
        setSelectedStageForFormula(stageId);
        setShowCustomFormulaModal(true);
        return; // Don't set calculation yet
      default:
        calculatedValue = '-';
    }

    setStageCalculations(prev => ({
      ...prev,
      [stageId]: { type: calculationType, value: calculatedValue }
    }));
  };

  const removeCalculation = (stageId: string) => {
    setStageCalculations(prev => {
      const newCalcs = { ...prev };
      delete newCalcs[stageId];
      return newCalcs;
    });
  };

  const handleCustomFormulaSubmit = (formula: string) => {
    if (!selectedStageForFormula) return;

    // For now, just display the formula as the value
    // In a real implementation, you would parse and evaluate the formula
    setStageCalculations(prev => ({
      ...prev,
      [selectedStageForFormula]: { type: 'custom', value: formula || t('sweep.weldcrm.pipelineKanban.customFormula') }
    }));

    setShowCustomFormulaModal(false);
    setSelectedStageForFormula(null);
  };

  const totalValue = stages.reduce((sum, stage) => sum + stage.value, 0);

  // Helper function to get deal field value for filtering
  const getDealFieldValue = (deal: Deal, field: string): string => {
    switch (field) {
      case 'stage':
        return deal.stage?.toLowerCase() || '';
      case 'value':
        return String(deal.value || 0);
      case 'probability':
        return String(deal.probability || 0);
      case 'company':
        return deal.company?.name?.toLowerCase() || '';
      default:
        return '';
    }
  };

  // Helper function to check if a deal matches a single filter
  const matchesFilter = (deal: Deal, filter: ActiveFilter): boolean => {
    const fieldValue = getDealFieldValue(deal, filter.field);
    const filterValue = filter.value.toLowerCase();

    // For numeric comparisons, parse the values
    const isNumericField = filter.field === 'value' || filter.field === 'probability';
    const numericFieldValue = isNumericField ? parseFloat(fieldValue) || 0 : 0;
    const numericFilterValue = isNumericField ? parseFloat(filter.value) || 0 : 0;

    switch (filter.operator) {
      case 'contains':
        return fieldValue.includes(filterValue);
      case 'not contains':
        return !fieldValue.includes(filterValue);
      case 'starts with':
        return fieldValue.startsWith(filterValue);
      case 'ends with':
        return fieldValue.endsWith(filterValue);
      case 'is':
        return fieldValue === filterValue;
      case 'is not':
        return fieldValue !== filterValue;
      case 'greater than':
        return numericFieldValue > numericFilterValue;
      case 'less than':
        return numericFieldValue < numericFilterValue;
      case 'greater or equal':
        return numericFieldValue >= numericFilterValue;
      case 'less or equal':
        return numericFieldValue <= numericFilterValue;
      case 'empty':
        return fieldValue === '' || fieldValue === '0';
      case 'not empty':
        return fieldValue !== '' && fieldValue !== '0';
      default:
        return true;
    }
  };

  // Filter stages based on search query and active filters
  const filteredStages = useMemo(() => {
    const hasSearchQuery = searchQuery.trim() !== '';
    const hasActiveFilters = activeFilters.length > 0;

    if (!hasSearchQuery && !hasActiveFilters) {
      return stages;
    }

    const query = searchQuery.toLowerCase();

    return stages.map(stage => {
      const filteredDeals = stage.deals.filter(deal => {
        // Apply search query filter
        if (hasSearchQuery) {
          const title = deal.title?.toLowerCase() || '';
          const company = deal.company?.name?.toLowerCase() || '';
          const contact = deal.contact?.name?.toLowerCase() || '';
          const owner = deal.owner?.name?.toLowerCase() || '';

          const matchesSearch = title.includes(query) ||
                               company.includes(query) ||
                               contact.includes(query) ||
                               owner.includes(query);

          if (!matchesSearch) return false;
        }

        // Apply active filters (all filters must match - AND logic)
        if (hasActiveFilters) {
          for (const filter of activeFilters) {
            if (!matchesFilter(deal, filter)) {
              return false;
            }
          }
        }

        return true;
      });

      return {
        ...stage,
        deals: filteredDeals,
        count: filteredDeals.length,
        value: filteredDeals.reduce((sum, deal) => sum + (deal.value || 0), 0),
      };
    });
  }, [stages, searchQuery, activeFilters]);

  const totalDeals = stages.reduce((sum, stage) => sum + stage.count, 0);
  const weightedValue = stages.reduce((sum, stage) => {
    if (stage.id === 'CLOSED_LOST') return sum;
    const probability = stage.probability || 0;
    return sum + (stage.value * probability / 100);
  }, 0);

  const handleOpenAddDeal = (stageId: string, stageName: string) => {
    setSelectedStageForNewDeal(stageId);
    setShowDealDetails(true);
  };

  const handleCreateDeal = async (data: any) => {
    if (onDealCreate) {
      await onDealCreate(data);
    }
    setShowDealDetails(false);
    setSelectedStageForNewDeal(null);
  };

  const handleEditDeal = (deal: Deal) => {
    setSelectedDealForEdit(deal);
    setShowEditDeal(true);
  };

  const handleOpenDealPanel = (deal: Deal) => {
    openObjectPanel({ type: 'opportunity', id: deal.id });
  };

  const handleUpdateDeal = async (dealId: string, data: any) => {
    try {
      const result = await updateOpportunityMutation.mutateAsync({ id: dealId, data });
      if (result?.id) {
        setStages(prevStages =>
          prevStages.map(stage => ({
            ...stage,
            deals: stage.deals.map(deal =>
              deal.id === dealId
                ? { ...deal, ...data }
                : deal
            ),
          }))
        );
      } else {
        console.error('Failed to update deal');
      }
    } catch (error) {
      console.error('Failed to update deal:', error);
    }
  };

  const handleDeleteDeal = async (dealId: string) => {
    try {
      await deleteOpportunityMutation.mutateAsync(dealId);
      setStages(prevStages =>
        prevStages.map(stage => ({
          ...stage,
          deals: stage.deals.filter(deal => deal.id !== dealId),
          count: stage.deals.filter(deal => deal.id !== dealId).length,
          value: stage.deals
            .filter(deal => deal.id !== dealId)
            .reduce((sum, deal) => sum + deal.value, 0),
        }))
      );
    } catch (error) {
      console.error('Failed to delete deal:', error);
    }
  };

  const handleCreateStage = async (name: string, color: string) => {
    // Generate a unique ID for optimistic UI update
    const tempStageId = `stage-${Date.now()}`;

    // Create a new stage with no deals
    const newStage: Stage = {
      id: tempStageId,
      name: name,
      color: color,
      deals: [],
      value: 0,
      count: 0,
      probability: 50,
    };

    // Optimistically add the new stage to the stages array
    setStages(prevStages => [...prevStages, newStage]);

    try {
      // Call API to persist the stage
      await createStageMutation.mutateAsync({
        name,
        color,
        probability: 50,
        pipeline: pipelineId || '',
      });
    } catch (error) {
      // Revert the optimistic update on error
      setStages(prevStages => prevStages.filter(s => s.id !== tempStageId));
      console.error('Failed to create stage:', error);
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden">
      {/* Header - matching EntityList top bar */}
      {!hideHeader && (
        <div className="flex-shrink-0">
          <div className="flex items-center justify-between px-4 h-[53px] border-b border-gray-200 dark:border-border">
            <FilterPills
              filters={activeFilters}
              filterConfigs={pipelineFilterConfigs}
              maxFilters={5}
              onFiltersChange={setActiveFilters}
            />

            <div className="flex items-center gap-2">
              {/* Search */}
              <div className="relative flex items-center">
                <div
                  className={cn(
                    "flex items-center transition-all duration-200 ease-out",
                    searchOpen ? "w-48" : "w-8"
                  )}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200",
                      searchOpen && "opacity-0 pointer-events-none absolute"
                    )}
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                  <div className={cn(
                    "relative transition-all duration-200 ease-out",
                    searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
                  )}>
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder={t('sweep.weldcrm.pipelineKanban.searchDeals')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onBlur={() => !searchQuery && setSearchOpen(false)}
                      className="h-8 w-full pl-8 pr-3 text-sm border border-gray-200 dark:border-border rounded-md bg-white dark:bg-background focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Add Deal */}
              <Button
                size="sm"
                className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 relative z-10"
                onClick={() => handleOpenAddDeal(stages[0]?.id || 'prospecting', stages[0]?.name || 'Prospecting')}
              >
                <Plus className="h-4 w-4 mr-0.5" />
                <span>{t('sweep.weldcrm.pipelineKanban.addDeal')}</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Kanban Board */}
      <div className="flex-1 flex flex-col overflow-hidden pb-0 select-none">
        <DndContext
          sensors={sensors}
          collisionDetection={customCollisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div
            ref={stagesScrollRef}
            className="flex gap-4 flex-1 overflow-x-scroll overflow-y-visible scrollbar-hidden pb-0"
            style={{ padding: '16px 16px' }}
            onScroll={(e) => {
              if (calculationScrollRef.current) {
                calculationScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
          >
              <SortableContext
                items={filteredStages.map(s => `sortable-stage-${s.id}`)}
                strategy={horizontalListSortingStrategy}
              >
                {filteredStages.map((stage) => (
                  <SortableStage key={stage.id} id={stage.id}>
                    <div className="flex flex-col h-full overflow-visible">
                      <DroppableStage
                        id={stage.id}
                        containerRef={containerRef}
                      >
                        <div className="flex flex-col h-full">
                          <StageHeader stage={stage} onAddDeal={handleOpenAddDeal} confettiEnabled={confettiStages.has(stage.id)} onConfettiChange={handleConfettiChange} />

                          {/* Deals container */}
                          <div className="flex-1 flex flex-col">
                            <div className="space-y-2">
                            <SortableContext
                              items={stage.deals.map(d => d.id)}
                              strategy={verticalListSortingStrategy}
                            >
                              {stage.deals.map((deal) => (
                              <DealCard
                                key={deal.id}
                                id={deal.id}
                                title={deal.title}
                                value={deal.value}
                                currency={deal.currency}
                                company={deal.company}
                                contact={deal.contact}
                                owner={deal.owner}
                                probability={deal.probability}
                                expectedCloseDate={deal.expectedCloseDate ? new Date(deal.expectedCloseDate) : undefined}
                                lastActivity={deal.lastActivity ? new Date(deal.lastActivity) : undefined}
                                tags={deal.tags}
                                onClick={() => handleOpenDealPanel(deal)}
                                onCompanyClick={(companyId) => {
                                  const customer = customers.find((c: any) => c.id === companyId);
                                  if (customer) {
                                    setSelectedCustomer({
                                      id: customer.id,
                                      email: customer.email || '',
                                      name: customer.name,
                                      company: customer.name,
                                      phone: customer.phone
                                    });
                                  }
                                }}
                                onContactClick={(contactId) => {
                                  const contact = contacts.find((c: any) => c.id === contactId);
                                  if (contact) {
                                    setSelectedCustomer({
                                      id: contact.id,
                                      email: contact.email || '',
                                      name: contact.name,
                                      phone: contact.phone
                                    });
                                  }
                                }}
                              />
                              ))}
                            </SortableContext>
                          </div>

                          {stage.deals.length === 0 && (
                            <Button
                              variant="ghost"
                              className="w-full h-auto py-2 px-4 bg-gray-50 dark:bg-background/50 border border-dashed border-gray-200 dark:border-border rounded-lg text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-background flex items-center justify-center gap-2 text-sm font-medium"
                              onClick={() => handleOpenAddDeal(stage.id, stage.name)}
                            >
                              <Plus className="h-4 w-4" />
                              {t('sweep.weldcrm.pipelineKanban.newDeal')}
                            </Button>
                          )}

                          {/* Spacer to extend drop zone to bottom */}
                          <div className="flex-1 min-h-[200px]"></div>
                          </div>
                        </div>
                      </DroppableStage>
                    </div>
                  </SortableStage>
                ))}
              </SortableContext>

              {/* Add New Stage Button */}
              <div className="flex-shrink-0">
                <AddStagePopover
                  open={showAddStage}
                  onOpenChange={setShowAddStage}
                  onAddStage={handleCreateStage}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 bg-white dark:bg-background border border-dashed border-gray-200 dark:border-border rounded-md text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-muted-foreground hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-secondary/50 flex items-center justify-center transition-all duration-200"
                    title={t('sweep.weldcrm.pipelineKanban.addNewStage')}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </AddStagePopover>
              </div>
            </div>

            <DragOverlay dropAnimation={{
              duration: 150,
              easing: 'ease-out',
            }}>
              {activeDeal ? (
                <div className="rotate-3 scale-105">
                  <DealCard
                    id={activeDeal.id}
                    title={activeDeal.title}
                    value={activeDeal.value}
                    currency={activeDeal.currency}
                    company={activeDeal.company}
                    contact={activeDeal.contact}
                    owner={activeDeal.owner}
                    probability={activeDeal.probability}
                    expectedCloseDate={activeDeal.expectedCloseDate ? new Date(activeDeal.expectedCloseDate) : undefined}
                    lastActivity={activeDeal.lastActivity ? new Date(activeDeal.lastActivity) : undefined}
                    tags={activeDeal.tags}
                    isDragging
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
      </div>

      {/* Calculation bar at bottom */}
      <div
        className="fixed bottom-0 bg-white dark:bg-background border-t border-gray-100 dark:border-border z-40 py-0"
        style={calcBarBounds ? { left: calcBarBounds.left, width: calcBarBounds.width } : { left: 0, right: 0 }}
      >
          <div
            ref={calculationScrollRef}
            className="flex gap-4 h-11 overflow-x-scroll overflow-y-hidden scrollbar-visible px-6 py-0"
            onScroll={(e) => {
              if (stagesScrollRef.current) {
                stagesScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
          >
            {filteredStages.map((stage) => (
              <div key={`calc-${stage.id}`} className="flex-shrink-0 w-[240px]">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {stageCalculations[stage.id] ? (
                      <Button variant="ghost" className="w-full h-11 flex items-center justify-between px-2 hover:bg-gray-50 dark:hover:bg-secondary/30 transition-colors cursor-pointer">
                        <span className="text-sm text-gray-600 dark:text-muted-foreground">
                          {stageCalculations[stage.id].type === 'total' && t('sweep.weldcrm.pipelineKanban.calcTotal')}
                          {stageCalculations[stage.id].type === 'average' && t('sweep.weldcrm.pipelineKanban.calcAvg')}
                          {stageCalculations[stage.id].type === 'winRate' && t('sweep.weldcrm.pipelineKanban.calcWin')}
                          {stageCalculations[stage.id].type === 'weighted' && t('sweep.weldcrm.pipelineKanban.calcWeighted')}
                          {stageCalculations[stage.id].type === 'distribution' && t('sweep.weldcrm.pipelineKanban.calcDist')}
                          {stageCalculations[stage.id].type === 'custom' && t('sweep.weldcrm.pipelineKanban.calcCustom')}
                        </span>
                        <span className="text-sm font-medium text-gray-900 dark:text-foreground">
                          {stageCalculations[stage.id].value}
                        </span>
                      </Button>
                    ) : (
                      <Button variant="ghost" className="w-full h-11 text-sm text-gray-400 hover:text-gray-600 dark:text-muted-foreground dark:hover:text-muted-foreground flex items-center justify-start gap-1 pl-2 hover:bg-gray-100 dark:hover:bg-background transition-colors">
                        <Plus className="h-3 w-3" />
                        {t('sweep.weldcrm.pipelineKanban.addCalculation')}
                      </Button>
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[240px]">
                    <DropdownMenuItem onClick={() => handleCalculation(stage.id, 'total')}>
                      <DollarSign className="h-4 w-4 mr-1" />
                      {t('sweep.weldcrm.pipelineKanban.totalValue')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleCalculation(stage.id, 'average')}>
                      <TrendingUp className="h-4 w-4 mr-1" />
                      {t('sweep.weldcrm.pipelineKanban.averageDealSize')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleCalculation(stage.id, 'winRate')}>
                      <Percent className="h-4 w-4 mr-1" />
                      {t('sweep.weldcrm.pipelineKanban.winRate')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleCalculation(stage.id, 'weighted')}>
                      <BarChart3 className="h-4 w-4 mr-1" />
                      {t('sweep.weldcrm.pipelineKanban.weightedValue')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleCalculation(stage.id, 'distribution')}>
                      <PieChart className="h-4 w-4 mr-1" />
                      {t('sweep.weldcrm.pipelineKanban.distribution')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleCalculation(stage.id, 'custom')}>
                      <Calculator className="h-4 w-4 mr-1" />
                      {t('sweep.weldcrm.pipelineKanban.customFormula')}
                    </DropdownMenuItem>
                    {stageCalculations[stage.id] && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => removeCalculation(stage.id)} className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400">
                          <Trash2 className="h-4 w-4 mr-1 text-red-600 dark:text-red-400" />
                          {t('sweep.weldcrm.pipelineKanban.delete')}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}

            {/* Spacer to match Add Stage button width */}
            <div className="flex-shrink-0 w-8"></div>
          </div>
      </div>

      {/* Deal Details Modal */}
      {selectedStageForNewDeal && (
        <DealDetailsModal
          open={showDealDetails}
          onOpenChange={setShowDealDetails}
          stages={stages.map(s => ({ id: s.id, name: s.name, color: s.color }))}
          selectedStageId={selectedStageForNewDeal}
          customers={customers}
          onSubmit={handleCreateDeal}
          lockedCustomer={lockedCustomer}
        />
      )}

      {/* Edit Deal Modal */}
      <EditDealModal
        open={showEditDeal}
        onOpenChange={setShowEditDeal}
        deal={selectedDealForEdit}
        onSubmit={handleUpdateDeal}
        onDelete={handleDeleteDeal}
      />

      {/* Custom Formula Modal */}
      <CustomFormulaModal
        open={showCustomFormulaModal}
        onOpenChange={setShowCustomFormulaModal}
        onSubmit={handleCustomFormulaSubmit}
      />

      {/* Pipeline Settings Modal */}
      <PipelineSettingsModal
        open={showPipelineSettings}
        onOpenChange={setShowPipelineSettings}
        customFields={customDealFields}
        onCustomFieldsChange={setCustomDealFields}
        viewSettings={viewSettings}
        onSettingsChange={updateViewSettings}
      />

      {/* Customer Detail Panel */}
      {selectedCustomer && (
        <Suspense fallback={null}>
        <CustomerDetailPanel
          email={selectedCustomer.email || ''}
          name={selectedCustomer.name}
          company={selectedCustomer.company}
          phone={selectedCustomer.phone}
          customerId={selectedCustomer.id}
          isOpen={true}
          onClose={() => setSelectedCustomer(null)}
        />
        </Suspense>
      )}

      {/* Confetti effect */}
    </div>
  );
}


function CustomFormulaModal({
  open,
  onOpenChange,
  onSubmit
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (formula: string) => void;
}) {
  const t = useTranslations();
  const [formula, setFormula] = useState('');

  const handleSubmit = () => {
    onSubmit(formula);
    setFormula(''); // Reset after submit
  };

  const handleCancel = () => {
    onOpenChange(false);
    setFormula(''); // Reset on cancel
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('sweep.weldcrm.customFormulaModal.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="formula">{t('sweep.weldcrm.customFormulaModal.formula')}</Label>
            <Textarea
              id="formula"
              placeholder={t('sweep.weldcrm.customFormulaModal.formulaPlaceholder')}
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              className="min-h-[120px]"
            />
            <p className="text-xs text-muted-foreground">
              {t('sweep.weldcrm.customFormulaModal.availableVariables')}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t('sweep.weldcrm.customFormulaModal.exampleFormulas')}</Label>
            <div className="text-xs text-muted-foreground space-y-1">
              <div>• <code className="bg-gray-100 dark:bg-background px-1 py-0.5 rounded">total_value * 0.9</code> - {t('sweep.weldcrm.customFormulaModal.example90Percent')}</div>
              <div>• <code className="bg-gray-100 dark:bg-background px-1 py-0.5 rounded">average_value * count</code> - {t('sweep.weldcrm.customFormulaModal.exampleTotalFromAverage')}</div>
              <div>• <code className="bg-gray-100 dark:bg-background px-1 py-0.5 rounded">count / 2</code> - {t('sweep.weldcrm.customFormulaModal.exampleHalfCount')}</div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {t('sweep.weldcrm.customFormulaModal.cancel')}
          </Button>
          <Button onClick={handleSubmit}>
            {t('sweep.weldcrm.customFormulaModal.applyFormula')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PipelineSettingsModal({
  open,
  onOpenChange,
  customFields,
  onCustomFieldsChange,
  viewSettings,
  onSettingsChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customFields: any[];
  onCustomFieldsChange: (fields: any[]) => void;
  viewSettings: PipelineViewSettings;
  onSettingsChange: (updates: Partial<PipelineViewSettings>) => Promise<void>;
}) {
  const t = useTranslations();
  // Initialize local state from viewSettings prop
  const [settings, setSettings] = useState({
    autoAdvance: viewSettings.autoAdvance,
    rottenDealDays: viewSettings.rottenDealDays,
    showProbability: viewSettings.showProbability,
    showExpectedCloseDate: viewSettings.showExpectedCloseDate,
    defaultCurrency: viewSettings.defaultCurrency,
    activityReminders: viewSettings.activityReminders,
    emailNotifications: viewSettings.emailNotifications,
    slackIntegration: viewSettings.slackIntegration,
  });

  // Sync local state when viewSettings prop changes
  useEffect(() => {
    setSettings({
      autoAdvance: viewSettings.autoAdvance,
      rottenDealDays: viewSettings.rottenDealDays,
      showProbability: viewSettings.showProbability,
      showExpectedCloseDate: viewSettings.showExpectedCloseDate,
      defaultCurrency: viewSettings.defaultCurrency,
      activityReminders: viewSettings.activityReminders,
      emailNotifications: viewSettings.emailNotifications,
      slackIntegration: viewSettings.slackIntegration,
    });
  }, [viewSettings]);
  const [currentView, setCurrentView] = useState<'settings' | 'customFields'>('settings');
  const [showAddFieldForm, setShowAddFieldForm] = useState(false);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [fieldTypeOpen, setFieldTypeOpen] = useState(false);
  const [newField, setNewField] = useState({
    name: '',
    type: 'text' as 'text' | 'number' | 'date' | 'select' | 'textarea',
    required: false,
    options: [] as string[],
  });

  const fieldTypes = [
    { value: 'text', label: t('sweep.weldcrm.pipelineSettingsModal.fieldTypeText') },
    { value: 'number', label: t('sweep.weldcrm.pipelineSettingsModal.fieldTypeNumber') },
    { value: 'date', label: t('sweep.weldcrm.pipelineSettingsModal.fieldTypeDate') },
    { value: 'select', label: t('sweep.weldcrm.pipelineSettingsModal.fieldTypeDropdown') },
    { value: 'textarea', label: t('sweep.weldcrm.pipelineSettingsModal.fieldTypeTextArea') },
  ];

  const currencies = [
    { value: 'USD', label: 'USD - US Dollar' },
    { value: 'EUR', label: 'EUR - Euro' },
    { value: 'GBP', label: 'GBP - British Pound' },
    { value: 'JPY', label: 'JPY - Japanese Yen' },
  ];

  const [currencyOpen, setCurrencyOpen] = useState(false);

  const handleSave = async () => {
    // Persist settings to database
    try {
      await onSettingsChange({
        ...settings,
        customFields: customFields.map(f => ({
          id: f.id,
          name: f.name,
          type: f.type,
          required: f.required,
          options: f.options,
        })),
      });
      onOpenChange(false);
      setCurrentView('settings'); // Reset view on close
    } catch (error) {
      console.error('Failed to save pipeline settings:', error);
    }
  };

  const handleAddField = () => {
    if (!newField.name) return;

    if (editingFieldId) {
      // Update existing field
      onCustomFieldsChange(customFields.map(f =>
        f.id === editingFieldId
          ? {
              ...f,
              name: newField.name,
              type: newField.type,
              required: newField.required,
              ...(newField.type === 'select' && { options: newField.options }),
            }
          : f
      ));
      setEditingFieldId(null);
    } else {
      // Add new field
      const field = {
        id: Date.now().toString(),
        name: newField.name,
        type: newField.type,
        required: newField.required,
        ...(newField.type === 'select' && { options: newField.options }),
      };
      onCustomFieldsChange([...customFields, field]);
    }

    setNewField({ name: '', type: 'text', required: false, options: [] });
    setShowAddFieldForm(false);
  };

  const handleEditField = (id: string) => {
    const fieldToEdit = customFields.find(f => f.id === id);
    if (fieldToEdit) {
      setNewField({
        name: fieldToEdit.name,
        type: fieldToEdit.type as any,
        required: fieldToEdit.required,
        options: (fieldToEdit as any).options || [],
      });
      setEditingFieldId(id);
      setShowAddFieldForm(true);
    }
  };

  const handleDeleteField = (id: string) => {
    onCustomFieldsChange(customFields.filter(f => f.id !== id));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto border-none [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-thumb]:rounded-full dark:[&::-webkit-scrollbar-thumb]:bg-gray-700"
      >
        <DialogHeader>
          {currentView === 'customFields' ? (
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => {
                  setCurrentView('settings');
                  setShowAddFieldForm(false);
                }}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="flex-1">
                <DialogTitle>{t('sweep.weldcrm.pipelineSettingsModal.customDealFields')}</DialogTitle>
              </div>
            </div>
          ) : (
            <>
              <DialogTitle>{t('sweep.weldcrm.pipelineSettingsModal.pipelineSettings')}</DialogTitle>
            </>
          )}
        </DialogHeader>

        {currentView === 'settings' ? (
          /* Settings View */
          <>
        <div className="space-y-8 py-4">
          {/* General Settings */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {t('sweep.weldcrm.pipelineSettingsModal.general')}
            </h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <Label htmlFor="autoAdvance" className="text-sm font-medium">
                    {t('sweep.weldcrm.pipelineSettingsModal.autoAdvanceDeals')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('sweep.weldcrm.pipelineSettingsModal.autoAdvanceDealsDescription')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    id="autoAdvance"
                    checked={settings.autoAdvance}
                    onChange={(e) => setSettings({ ...settings, autoAdvance: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                  <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rottenDealDays" className="text-sm font-medium">
                  {t('sweep.weldcrm.pipelineSettingsModal.rottenDealThreshold')}
                </Label>
                <Input
                  id="rottenDealDays"
                  type="number"
                  value={settings.rottenDealDays}
                  onChange={(e) => setSettings({ ...settings, rottenDealDays: parseInt(e.target.value) })}
                  className="max-w-[200px]"
                />
                <p className="text-xs text-muted-foreground">
                  {t('sweep.weldcrm.pipelineSettingsModal.rottenDealThresholdDescription')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="defaultCurrency" className="text-sm font-medium">
                  {t('sweep.weldcrm.pipelineSettingsModal.defaultCurrency')}
                </Label>
                <Popover open={currencyOpen} onOpenChange={setCurrencyOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={currencyOpen}
                      className="w-[200px] justify-between shadow-none"
                    >
                      {settings.defaultCurrency
                        ? currencies.find((currency) => currency.value === settings.defaultCurrency)?.label
                        : t('sweep.weldcrm.pipelineSettingsModal.selectCurrency')}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[200px] p-0" align="start">
                    <Command>
                      <CommandList>
                        <CommandGroup>
                          {currencies.map((currency) => (
                            <CommandItem
                              key={currency.value}
                              value={currency.value}
                              onSelect={(currentValue) => {
                                setSettings({ ...settings, defaultCurrency: currentValue.toUpperCase() });
                                setCurrencyOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  settings.defaultCurrency === currency.value ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {currency.label}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          {/* Display Settings */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {t('sweep.weldcrm.pipelineSettingsModal.display')}
            </h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <Label htmlFor="showProbability" className="text-sm font-medium">
                    {t('sweep.weldcrm.pipelineSettingsModal.showDealProbability')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('sweep.weldcrm.pipelineSettingsModal.showDealProbabilityDescription')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    id="showProbability"
                    checked={settings.showProbability}
                    onChange={(e) => setSettings({ ...settings, showProbability: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                  <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <Label htmlFor="showExpectedCloseDate" className="text-sm font-medium">
                    {t('sweep.weldcrm.pipelineSettingsModal.showExpectedCloseDate')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('sweep.weldcrm.pipelineSettingsModal.showExpectedCloseDateDescription')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    id="showExpectedCloseDate"
                    checked={settings.showExpectedCloseDate}
                    onChange={(e) => setSettings({ ...settings, showExpectedCloseDate: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                  <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>
            </div>
          </div>

          {/* Notifications */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {t('sweep.weldcrm.pipelineSettingsModal.notifications')}
            </h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <Label htmlFor="activityReminders" className="text-sm font-medium">
                    {t('sweep.weldcrm.pipelineSettingsModal.activityReminders')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('sweep.weldcrm.pipelineSettingsModal.activityRemindersDescription')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    id="activityReminders"
                    checked={settings.activityReminders}
                    onChange={(e) => setSettings({ ...settings, activityReminders: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                  <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <Label htmlFor="emailNotifications" className="text-sm font-medium">
                    {t('sweep.weldcrm.pipelineSettingsModal.emailNotifications')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('sweep.weldcrm.pipelineSettingsModal.emailNotificationsDescription')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    id="emailNotifications"
                    checked={settings.emailNotifications}
                    onChange={(e) => setSettings({ ...settings, emailNotifications: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                  <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>
            </div>
          </div>

          {/* Integrations */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
              {t('sweep.weldcrm.pipelineSettingsModal.integrations')}
            </h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <Label htmlFor="slackIntegration" className="text-sm font-medium">
                    {t('sweep.weldcrm.pipelineSettingsModal.slackNotifications')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('sweep.weldcrm.pipelineSettingsModal.slackNotificationsDescription')}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    id="slackIntegration"
                    checked={settings.slackIntegration}
                    onChange={(e) => setSettings({ ...settings, slackIntegration: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                  <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Custom Fields Setup Section */}
        <div className="border border-gray-200 dark:border-border rounded-lg mt-6">
          <Button
            variant="ghost"
            onClick={() => setCurrentView('customFields')}
            className="w-full px-6 py-4 bg-gray-50 dark:bg-background/50 hover:bg-gray-100 dark:hover:bg-secondary/50 transition-colors text-left group rounded-lg"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-gray-200 dark:bg-secondary rounded-lg group-hover:bg-gray-300 dark:group-hover:bg-accent transition-colors">
                  <Settings className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                </div>
                <div>
                  <h4 className="text-sm font-medium text-gray-900 dark:text-white">
                    {t('sweep.weldcrm.pipelineSettingsModal.customDealFields')}
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    {t('sweep.weldcrm.pipelineSettingsModal.customDealFieldsDescription')}
                  </p>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-muted-foreground transition-colors" />
            </div>
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="shadow-none">
            {t('sweep.weldcrm.pipelineSettingsModal.cancel')}
          </Button>
          <Button onClick={handleSave}>
            {t('sweep.weldcrm.pipelineSettingsModal.saveChanges')}
          </Button>
        </DialogFooter>
        </>
        ) : (
          /* Custom Fields View */
          <>
        <div className="space-y-4 py-4">
          {/* Existing Custom Fields */}
          {customFields.length > 0 && (
            <div className="space-y-3">
              <Label className="text-sm font-medium">{t('sweep.weldcrm.pipelineSettingsModal.customFields')}</Label>
              {customFields.map((field) => (
                <div
                  key={field.id}
                  className="flex items-center justify-between p-3 border border-gray-200 dark:border-border rounded-lg hover:bg-gray-50 dark:hover:bg-background/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 dark:text-white">
                        {field.name}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {field.type}
                      </Badge>
                      {field.required && (
                        <Badge variant="secondary" className="text-xs">
                          {t('sweep.weldcrm.pipelineSettingsModal.required')}
                        </Badge>
                      )}
                    </div>
                    {field.type === 'select' && field.options && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('sweep.weldcrm.pipelineSettingsModal.optionsList', { options: field.options.join(', ') })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => handleEditField(field.id)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                      onClick={() => handleDeleteField(field.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add New Field Form */}
          {showAddFieldForm ? (
            <div className="space-y-4 p-4 border border-gray-200 dark:border-border rounded-lg bg-gray-50 dark:bg-background/50">
              <div className="space-y-2">
                <Label htmlFor="fieldName">{t('sweep.weldcrm.pipelineSettingsModal.fieldName')}</Label>
                <Input
                  id="fieldName"
                  placeholder={t('sweep.weldcrm.pipelineSettingsModal.fieldNamePlaceholder')}
                  value={newField.name}
                  onChange={(e) => setNewField({ ...newField, name: e.target.value })}
                  className="shadow-none bg-white dark:bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="fieldType">{t('sweep.weldcrm.pipelineSettingsModal.fieldType')}</Label>
                <Popover open={fieldTypeOpen} onOpenChange={setFieldTypeOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={fieldTypeOpen}
                      className="w-full justify-between shadow-none"
                    >
                      {newField.type
                        ? fieldTypes.find((type) => type.value === newField.type)?.label
                        : t('sweep.weldcrm.pipelineSettingsModal.selectFieldType')}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full p-0" align="start">
                    <Command>
                      <CommandList>
                        <CommandGroup>
                          {fieldTypes.map((type) => (
                            <CommandItem
                              key={type.value}
                              value={type.value}
                              onSelect={(currentValue) => {
                                setNewField({ ...newField, type: currentValue as any });
                                setFieldTypeOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  newField.type === type.value ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {type.label}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {newField.type === 'select' && (
                <div className="space-y-2">
                  <Label>{t('sweep.weldcrm.pipelineSettingsModal.options')}</Label>
                  <div className="space-y-2">
                    {(newField.options || []).map((option, index) => (
                      <div key={index} className="flex gap-2">
                        <Input
                          placeholder={t('sweep.weldcrm.pipelineSettingsModal.optionPlaceholder', { number: index + 1 })}
                          value={option}
                          onChange={(e) => {
                            const newOptions = [...(newField.options || [])];
                            newOptions[index] = e.target.value;
                            setNewField({ ...newField, options: newOptions });
                          }}
                          className="shadow-none bg-white dark:bg-background"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-10 w-10 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                          onClick={() => {
                            const newOptions = (newField.options || []).filter((_, i) => i !== index);
                            setNewField({ ...newField, options: newOptions });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full shadow-none"
                      onClick={() => {
                        setNewField({
                          ...newField,
                          options: [...(newField.options || []), '']
                        });
                      }}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      {t('sweep.weldcrm.pipelineSettingsModal.addOption')}
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between">
                <Label htmlFor="fieldRequired" className="text-sm font-normal">
                  {t('sweep.weldcrm.pipelineSettingsModal.makeFieldRequired')}
                </Label>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    id="fieldRequired"
                    checked={newField.required}
                    onChange={(e) => setNewField({ ...newField, required: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-7 h-4 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors"></div>
                  <div className="absolute left-[2px] top-[2px] bg-white w-3 h-3 rounded-full transition-transform peer-checked:translate-x-3"></div>
                </label>
              </div>

              <div className="flex gap-2">
                <Button onClick={handleAddField} size="sm">
                  {editingFieldId ? t('sweep.weldcrm.pipelineSettingsModal.updateField') : t('sweep.weldcrm.pipelineSettingsModal.addField')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="shadow-none h-[33px]"
                  onClick={() => {
                    setShowAddFieldForm(false);
                    setEditingFieldId(null);
                    setNewField({ name: '', type: 'text', required: false, options: [] });
                  }}
                >
                  {t('sweep.weldcrm.pipelineSettingsModal.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              className="w-full shadow-none"
              onClick={() => setShowAddFieldForm(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              {t('sweep.weldcrm.pipelineSettingsModal.addCustomField')}
            </Button>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleSave}>
            {t('sweep.weldcrm.pipelineSettingsModal.saveCustomFields')}
          </Button>
        </DialogFooter>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}