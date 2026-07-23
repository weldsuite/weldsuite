
import React, { useState } from "react";
import { getCategoryStyle } from "./tailwind-helpers";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Label } from "@weldsuite/ui/components/label";
import { Checkbox } from "@weldsuite/ui/components/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weldsuite/ui/components/select";
import { TagLabel } from "@/components/weldflow/tag-label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@weldsuite/ui/components/dialog";
import {
  Plus,
  Search,
  Filter,
  EllipsisVertical,
  Calendar,
  User,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  X,
  Check,
  Hash,
  Type,
  CalendarDays,
  Users,
  Flag,
  Tag,
  Percent,
  DollarSign,
  Link2,
  Mail,
  Phone,
  FileText,
  CheckSquare,
  List,
  Settings,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Trash2,
  Edit3,
  Globe,
  Building2,
  MessageSquare,
  Twitter,
  Linkedin,
  Facebook,
  Instagram,
  Youtube,
  Github,
  BarChart3,
  TrendingUp,
  Clock,
  MapPin,
  Briefcase,
  CircleCheck,
  Timer,
  Layers,
  FolderOpen,
  CalendarClock,
  UserPlus,
  GitBranch,
  Ban,
  Activity,
  Edit,
  CalendarPlus,
  UserCheck,
  UsersRound,
  CheckCircle2,
  Circle,
  Square,
  Calculator,
  Fingerprint,
  PencilLine,
  Play,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@weldsuite/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@weldsuite/ui/components/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@weldsuite/ui/components/tooltip";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@weldsuite/ui/components/command";
import { cn } from "@/lib/utils";
import { Badge } from "@weldsuite/ui/components/badge";
import { Calendar as CalendarComponent } from "@weldsuite/ui/components/calendar";
import { toast } from "sonner";
import { useTranslations } from "@weldsuite/i18n/client";

type FieldType =
  | "checkbox"
  | "text"
  | "number"
  | "date"
  | "person"
  | "status"
  | "categories"
  | "linkedin"
  | "twitter"
  | "domain"
  | "interaction"
  | "tags"
  | "email"
  | "phone"
  | "currency"
  | "single-select"
  | "multi-select"
  | "people"
  | "formula"
  | "id"
  | "timer"
  | "time-tracking"
  | "rollup"
  | "projects"
  | "due-date"
  | "assignee"
  | "completed-on"
  | "last-modified-on"
  | "created-on"
  | "created-by"
  | "collaborators";

interface Field {
  id: string;
  name: string;
  type: FieldType;
  width?: number;
  icon?: React.ElementType;
  visible?: boolean;
  checkedLabel?: string;
  uncheckedLabel?: string;
  options?: string[];
  rollupConfig?: {
    relationField: string; // Field that links to other rows (e.g., "projects")
    targetField: string; // Field to aggregate from linked rows
    aggregation: 'sum' | 'average' | 'count' | 'min' | 'max';
  };
}

interface Row {
  id: string;
  data: Record<string, any>;
}

// Sample team members for people selection
const teamMembers = [
  { id: "1", name: "John Doe", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=John", email: "john@example.com" },
  { id: "2", name: "Jane Smith", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Jane", email: "jane@example.com" },
  { id: "3", name: "Bob Johnson", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Bob", email: "bob@example.com" },
  { id: "4", name: "Alice Williams", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Alice", email: "alice@example.com" },
  { id: "5", name: "Charlie Brown", avatar: "https://api.dicebear.com/7.x/avataaars/svg?seed=Charlie", email: "charlie@example.com" },
];

// Sample select options
const selectOptions = [
  "Option 1", "Option 2", "Option 3", "Option 4", "Option 5"
];

// Sample project list
const projectsList = [
  "Project Alpha", "Project Beta", "Project Gamma", "Project Delta", "Project Epsilon"
];

const fieldTypeOptions = [
  { value: "checkbox", label: "Checkbox", icon: CheckSquare },
  { value: "single-select", label: "Single-select", icon: Circle },
  { value: "multi-select", label: "Multi-select", icon: CheckSquare },
  { value: "date", label: "Date", icon: Calendar },
  { value: "people", label: "People", icon: User },
  { value: "text", label: "Text", icon: Type },
  { value: "number", label: "Number", icon: Hash },
  { value: "formula", label: "Formula", icon: Calculator },
  { value: "id", label: "ID", icon: Fingerprint },
  { value: "timer", label: "Timer", icon: Timer },
  { value: "time-tracking", label: "Time tracking", icon: Clock },
  { value: "rollup", label: "Rollup", icon: Layers },
  { value: "projects", label: "Projects", icon: FolderOpen },
  { value: "due-date", label: "Due Date", icon: CalendarClock },
  { value: "tags", label: "Tags", icon: Tag },
  { value: "assignee", label: "Assignee", icon: UserCheck },
  { value: "completed-on", label: "Completed on", icon: CheckCircle2 },
  { value: "last-modified-on", label: "Last modified on", icon: Edit },
  { value: "created-on", label: "Created on", icon: CalendarPlus },
  { value: "created-by", label: "Created by", icon: UserPlus },
  { value: "collaborators", label: "Collaborators", icon: UsersRound },
];

const categoryColors: Record<string, string> = {
  "Airlines": "category-airlines",
  "Finance": "category-finance",
  "Consumer Discretionary": "category-consumer",
  "Entertainment & Recreation": "category-entertainment",
  "Computer Hardware": "category-hardware",
  "Broadcasting": "category-broadcasting",
  "Enterprise": "category-enterprise",
  "B2B": "category-b2b",
  "B2C": "category-b2c",
  "Automation": "category-automation",
  "E-commerce": "category-ecommerce",
  "Transport": "category-transport",
  "Financial Services": "category-financial",
  "Publishing": "category-publishing",
  "Internet": "category-internet",
  "Marketplace": "category-marketplace",
  "SaaS": "category-saas",
  "Information Technology": "category-it",
};

const companies = [
  {
    id: "1",
    name: "United Airlines",
    initials: "UA",
    color: "#005DAA",
    categories: ["Airlines", "B2C", "E-commerce", "Transport"],
    linkedin: "united-airlines",
    lastInteraction: "No contact",
    twitter: { followers: "1.174.209", handle: "united" },
    domain: "united.com",
    description: "United Airlines, a subsidiary of United Airlines Holdings, Inc., is a major American airline...",
  },
  {
    id: "2",
    name: "PayPal",
    initials: "PP",
    color: "#003087",
    categories: ["B2C", "Finance", "Financial Services", "Information Technology"],
    linkedin: "paypal",
    lastInteraction: "No contact",
    twitter: { followers: "969.425", handle: "PayPal" },
    domain: "paypal.com",
    description: "PayPal is a leading digital payments platform...",
  },
  {
    id: "3",
    name: "Intercom",
    initials: "IC",
    color: "#4C9BFF",
    categories: ["B2B", "Information Technology", "Publishing", "SaaS"],
    linkedin: "intercom",
    lastInteraction: "No contact",
    twitter: { followers: "42.427", handle: "intercom" },
    domain: "intercom.com",
    description: "Intercom provides an AI-first customer service platform...",
  },
  {
    id: "4",
    name: "Airbnb",
    initials: "AB",
    color: "#FF5A5F",
    categories: ["B2C", "Information Technology", "Internet", "Marketplace"],
    linkedin: "airbnb",
    lastInteraction: "No contact",
    twitter: { followers: "883.549", handle: "Airbnb" },
    domain: "airbnb.com",
    description: "Airbnb is the world's largest accommodation sharing site...",
  },
  {
    id: "5",
    name: "Apple",
    initials: "AP",
    color: "#555555",
    categories: ["B2C", "Computer Hardware", "Consumer Discretionary"],
    linkedin: "apple",
    lastInteraction: "No contact",
    twitter: { followers: "9.119.742", handle: "Apple" },
    domain: "apple.com",
    description: "Apple is a multinational technology company...",
  },
  {
    id: "6",
    name: "LVMH",
    initials: "LV",
    color: "#000000",
    categories: ["B2C", "Consumer Discretionary", "E-commerce"],
    linkedin: "lvmh",
    lastInteraction: "No contact",
    twitter: { followers: "198.135", handle: "LVMH" },
    domain: "lvmh.com",
    description: "LVMH, the world leader in luxury, owns 75 Maisons...",
  },
  {
    id: "7",
    name: "Disney",
    initials: "DI",
    color: "#113CCF",
    categories: ["B2C", "Entertainment & Recreation"],
    linkedin: "the-walt-disney-company",
    lastInteraction: "No contact",
    twitter: { followers: "10.140.332", handle: "Disney" },
    domain: "disney.com",
    description: "Disney serves as a cornerstone for entertainment...",
  },
  {
    id: "8",
    name: "Google",
    initials: "GO",
    color: "#4285F4",
    categories: ["B2B", "B2C", "Broadcasting", "Information Technology"],
    linkedin: "google",
    lastInteraction: "No contact",
    twitter: { followers: "28.946.065", handle: "Google" },
    domain: "google.com",
    description: "Google specializes in internet-related services...",
  },
  {
    id: "9",
    name: "Attio",
    initials: "AT",
    color: "#5469D4",
    categories: ["Automation", "B2B", "Enterprise", "Information Technology"],
    linkedin: "attio",
    lastInteraction: "1 day ago",
    twitter: { followers: "1.340", handle: "attio" },
    domain: "attio.com",
    description: "Attio provides a customer relationship management platform...",
  },
  {
    id: "10",
    name: "Microsoft",
    initials: "MS",
    color: "#00BCF2",
    categories: ["B2B", "Enterprise", "Information Technology", "Publishing"],
    linkedin: "microsoft",
    lastInteraction: "No contact",
    twitter: { followers: "12.814.907", handle: "Microsoft" },
    domain: "microsoft.com",
    description: "Microsoft develops, licenses, and supports software...",
  },
];

const defaultFields: Field[] = [
  {
    id: "linkedin",
    name: "Linkedin",
    type: "linkedin",
    width: 200,
    icon: Linkedin,
    visible: true,
  },
  {
    id: "last_interaction",
    name: "Last interaction",
    type: "interaction",
    width: 200,
    icon: Clock,
    visible: true,
  },
  {
    id: "connection_strength",
    name: "Connection strength",
    type: "status",
    width: 200,
    icon: BarChart3,
    visible: true,
  },
  {
    id: "twitter_followers",
    name: "Twitter followers",
    type: "number",
    width: 200,
    icon: Twitter,
    visible: true,
  },
  {
    id: "twitter",
    name: "Twitter",
    type: "text",
    width: 200,
    icon: Twitter,
    visible: true,
  },
  {
    id: "revenue",
    name: "Revenue",
    type: "currency",
    width: 200,
    icon: DollarSign,
    visible: true,
  },
  {
    id: "employees",
    name: "Employees",
    type: "number",
    width: 200,
    icon: Users,
    visible: true,
  },
  {
    id: "domains",
    name: "Domains",
    type: "domain",
    width: 200,
    icon: Globe,
    visible: true,
  },
  {
    id: "description",
    name: "Description",
    type: "text",
    width: 200,
    icon: FileText,
    visible: true,
  },
];

// Avatar color palette
const avatarColors = [
  '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981',
  '#06b6d4', '#f43f5e', '#6366f1', '#84cc16', '#a855f7',
];

const getAvatarColor = (name: string) => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
};

const getDefaultWidthForFieldType = (type: FieldType): number => {
  switch (type) {
    case "checkbox": return 200;
    case "text": return 200;
    case "email": return 200;
    case "phone": return 200;
    case "number": return 200;
    case "currency": return 200;
    case "date": return 200;
    case "single-select": return 200;
    case "multi-select": return 200;
    case "people":
    case "assignee":
    case "created-by": return 200;
    case "tags":
    case "categories": return 200;
    case "timer":
    case "time-tracking": return 200;
    case "collaborators": return 200;
    default: return 200;
  }
};

const getDefaultValueForFieldType = (type: FieldType) => {
  switch (type) {
    case "checkbox": return false;
    case "text":
    case "email":
    case "phone": return "";
    case "number":
    case "currency": return 0;
    case "date":
    case "due-date":
    case "completed-on":
    case "last-modified-on":
    case "created-on": return new Date().toISOString().split('T')[0];
    case "single-select": return null;
    case "multi-select":
    case "tags":
    case "categories": return [];
    case "people":
    case "assignee":
    case "created-by": return null;
    case "collaborators": return [];
    case "timer":
    case "time-tracking": return "00:00:00";
    case "formula": return "";
    case "id": return `ID-${Date.now()}`;
    case "rollup": return 0;
    case "projects": return "No project";
    default: return "";
  }
};

// Cell wrapper component that enforces 40px height
const CellWrapper: React.FC<{ children: React.ReactNode; onClick?: React.MouseEventHandler<HTMLDivElement>; style?: React.CSSProperties }> = ({ children, onClick, style }) => (
  <div
    onClick={onClick}
    style={{
      height: '40px',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      overflow: 'hidden',
      padding: '0 12px',
      cursor: onClick ? 'pointer' : 'default',
      ...style
    }}
  >
    <div style={{
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      gap: '4px'
    }}>
      {children}
    </div>
  </div>
);

export default function TablePage() {
  const st = useTranslations();
  const [fields, setFields] = useState<Field[]>(defaultFields);
  const [customFieldDialog, setCustomFieldDialog] = useState<{
    open: boolean;
    name: string;
    description: string;
    type: FieldType
  }>({
    open: false,
    name: "",
    description: "",
    type: "text"
  });
  const [editFieldDialog, setEditFieldDialog] = useState<{
    open: boolean;
    fieldId: string;
    name: string;
  }>({
    open: false,
    fieldId: "",
    name: "",
  });
  const [createTagDialog, setCreateTagDialog] = useState<{
    open: boolean;
    rowId: string;
    fieldId: string;
    tagName: string;
    tagColor: string;
  }>({
    open: false,
    rowId: "",
    fieldId: "",
    tagName: "",
    tagColor: "#3b82f6",
  });
  const [checkboxLabelDialog, setCheckboxLabelDialog] = useState<{
    open: boolean;
    fieldId: string;
    checkedLabel: string;
    uncheckedLabel: string;
  }>({
    open: false,
    fieldId: "",
    checkedLabel: "Checked",
    uncheckedLabel: "Unchecked",
  });
  const [createOptionDialog, setCreateOptionDialog] = useState<{
    open: boolean;
    fieldId: string;
    rowId: string;
    optionName: string;
    optionColor: string;
  }>({
    open: false,
    fieldId: "",
    rowId: "",
    optionName: "",
    optionColor: "#3b82f6",
  });
  const [sortConfig, setSortConfig] = useState<{
    field: string | null;
    direction: 'asc' | 'desc' | null;
  }>({ field: null, direction: null });
  const [filters, setFilters] = useState<Array<{
    id: string;
    field: string;
    operator: 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'greater_than' | 'less_than' | 'is_empty' | 'is_not_empty';
    value: any;
  }>>([]);
  const [runningTimers, setRunningTimers] = useState<Record<string, { startTime: number; elapsed: number }>>({});
  const [rows, setRows] = useState<Row[]>(
    companies.map(company => ({
      id: company.id,
      data: {
        company: company,
        categories: company.categories,
        linkedin: company.linkedin,
        last_interaction: company.lastInteraction,
        connection_strength: company.lastInteraction === "1 day ago" ? "Very weak" : "No communication",
        twitter_followers: parseInt(company.twitter.followers.replace(/\./g, '').replace(/,/g, '')) || 0,
        twitter: company.twitter.handle,
        revenue: parseInt(company.id) * 12500000,
        employees: parseInt(company.id) * 5000 + 1000,
        domains: company.domain,
        description: company.description,
      },
    }))
  );
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [editingCell, setEditingCell] = useState<{ rowId: string; fieldId: string } | null>(null);
  const [editValue, setEditValue] = useState<any>("");
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    const widths: Record<string, number> = {};
    fields.forEach(field => {
      widths[field.id] = field.width || 150;
    });
    return widths;
  });
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const [fieldCalculations, setFieldCalculations] = useState<Record<string, string>>({});

  // Refs for synchronized scrolling
  const tableScrollRef = React.useRef<HTMLDivElement>(null);
  const footerScrollRef = React.useRef<HTMLDivElement>(null);
  const scrollbarRef = React.useRef<HTMLDivElement>(null);

  // Update running timers every second
  React.useEffect(() => {
    if (Object.keys(runningTimers).length === 0) return;

    const interval = setInterval(() => {
      setRows(prevRows => {
        const updatedRows = [...prevRows];
        let hasChanges = false;

        Object.entries(runningTimers).forEach(([timerKey, timer]) => {
          const [rowId, fieldId] = timerKey.split('-');
          const rowIndex = updatedRows.findIndex(r => r.id === rowId);

          if (rowIndex !== -1) {
            const field = fields.find(f => f.id === fieldId);

            if (field?.type === 'timer') {
              // Countdown timer
              const remaining = timer.elapsed - (Date.now() - timer.startTime);
              if (remaining <= 0) {
                // Timer finished
                updatedRows[rowIndex] = {
                  ...updatedRows[rowIndex],
                  data: { ...updatedRows[rowIndex].data, [fieldId]: "00:00:00" }
                };
                setRunningTimers(prev => {
                  const newTimers = { ...prev };
                  delete newTimers[timerKey];
                  return newTimers;
                });
                toast.success(st('sweep.weldflow.tablePage.timerFinished'));
                hasChanges = true;
              } else {
                const totalSeconds = Math.ceil(remaining / 1000);
                const hours = Math.floor(totalSeconds / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                const seconds = totalSeconds % 60;
                const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

                if (updatedRows[rowIndex].data[fieldId] !== timeString) {
                  updatedRows[rowIndex] = {
                    ...updatedRows[rowIndex],
                    data: { ...updatedRows[rowIndex].data, [fieldId]: timeString }
                  };
                  hasChanges = true;
                }
              }
            } else {
              // Time tracking (count up)
              const elapsed = timer.elapsed + (Date.now() - timer.startTime);
              const hours = Math.floor(elapsed / 3600000);
              const minutes = Math.floor((elapsed % 3600000) / 60000);
              const seconds = Math.floor((elapsed % 60000) / 1000);
              const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

              if (updatedRows[rowIndex].data[fieldId] !== timeString) {
                updatedRows[rowIndex] = {
                  ...updatedRows[rowIndex],
                  data: { ...updatedRows[rowIndex].data, [fieldId]: timeString }
                };
                hasChanges = true;
              }
            }
          }
        });

        return hasChanges ? updatedRows : prevRows;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [runningTimers, fields]);

  const handleCellEdit = (rowId: string, fieldId: string, value: any) => {
    setEditingCell({ rowId, fieldId });
    setEditValue(value || "");
  };

  const saveCellEdit = () => {
    if (editingCell) {
      setRows(rows.map(row =>
        row.id === editingCell.rowId
          ? { ...row, data: { ...row.data, [editingCell.fieldId]: editValue } }
          : row
      ));
      setEditingCell(null);
      setEditValue("");
    }
  };

  const addNewRow = () => {
    const newRow: Row = {
      id: `row_${Date.now()}`,
      data: {
        company: {
          id: `company_${Date.now()}`,
          name: "New Company",
          initials: "NC",
          color: "#888888",
        },
        categories: [],
        linkedin: "",
        last_interaction: "No contact",
        connection_strength: "No communication",
        twitter_followers: "",
        twitter: "",
        domains: "",
        description: "",
      },
    };
    setRows([...rows, newRow]);
  };

  const applyFilters = (rowsToFilter: Row[]) => {
    if (filters.length === 0) return rowsToFilter;

    return rowsToFilter.filter(row => {
      return filters.every(filter => {
        const value = row.data[filter.field];
        const filterValue = filter.value;

        switch (filter.operator) {
          case 'equals':
            return value === filterValue;
          case 'contains':
            return String(value || '').toLowerCase().includes(String(filterValue).toLowerCase());
          case 'starts_with':
            return String(value || '').toLowerCase().startsWith(String(filterValue).toLowerCase());
          case 'ends_with':
            return String(value || '').toLowerCase().endsWith(String(filterValue).toLowerCase());
          case 'greater_than':
            return Number(value) > Number(filterValue);
          case 'less_than':
            return Number(value) < Number(filterValue);
          case 'is_empty':
            return !value || value === '' || (Array.isArray(value) && value.length === 0);
          case 'is_not_empty':
            return value && value !== '' && (!Array.isArray(value) || value.length > 0);
          default:
            return true;
        }
      });
    });
  };

  const handleSortColumn = (fieldId: string, direction: 'asc' | 'desc') => {
    setSortConfig({ field: fieldId, direction });

    const sortedRows = [...rows].sort((a, b) => {
      const aValue = a.data[fieldId];
      const bValue = b.data[fieldId];

      if (aValue === null || aValue === undefined) return 1;
      if (bValue === null || bValue === undefined) return -1;

      if (typeof aValue === 'object' && aValue.name) {
        const comparison = aValue.name.localeCompare(bValue.name);
        return direction === 'asc' ? comparison : -comparison;
      }

      if (Array.isArray(aValue)) {
        const comparison = aValue.length - bValue.length;
        return direction === 'asc' ? comparison : -comparison;
      }

      if (typeof aValue === 'string') {
        const comparison = aValue.localeCompare(bValue);
        return direction === 'asc' ? comparison : -comparison;
      }

      if (typeof aValue === 'number') {
        const comparison = aValue - bValue;
        return direction === 'asc' ? comparison : -comparison;
      }

      return 0;
    });

    setRows(sortedRows);
  };

  const handleMoveColumn = (fieldId: string, direction: 'left' | 'right') => {
    const currentIndex = fields.findIndex(f => f.id === fieldId);
    if (currentIndex === -1) return;

    const newIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= fields.length) return;

    const newFields = [...fields];
    const [movedField] = newFields.splice(currentIndex, 1);
    newFields.splice(newIndex, 0, movedField);

    setFields(newFields);
  };

  const handleHideColumn = (fieldId: string) => {
    setFields(fields.map(field =>
      field.id === fieldId ? { ...field, visible: false } : field
    ));
  };

  const handleDeleteColumn = (fieldId: string) => {
    setFields(fields.filter(field => field.id !== fieldId));
    setRows(rows.map(row => {
      const newData = { ...row.data };
      delete newData[fieldId];
      return { ...row, data: newData };
    }));
  };

  const handleEditFieldName = (fieldId: string, newName: string) => {
    setFields(fields.map(field =>
      field.id === fieldId ? { ...field, name: newName } : field
    ));
  };

  const handleMouseDown = (e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingColumn(fieldId);

    const startX = e.clientX;
    const startWidth = columnWidths[fieldId] || 150;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const newWidth = Math.max(50, startWidth + deltaX);
      setColumnWidths(prev => ({ ...prev, [fieldId]: newWidth }));
    };

    const handleMouseUp = () => {
      setResizingColumn(null);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'auto';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
  };

  // Handle scroll synchronization
  const handleTableScroll = () => {
    if (tableScrollRef.current && scrollbarRef.current && footerScrollRef.current) {
      const scrollLeft = tableScrollRef.current.scrollLeft;
      scrollbarRef.current.scrollLeft = scrollLeft;
      footerScrollRef.current.scrollLeft = scrollLeft;
    }
  };

  const handleScrollbarScroll = () => {
    if (tableScrollRef.current && scrollbarRef.current && footerScrollRef.current) {
      const scrollLeft = scrollbarRef.current.scrollLeft;
      tableScrollRef.current.scrollLeft = scrollLeft;
      footerScrollRef.current.scrollLeft = scrollLeft;
    }
  };

  // Calculate total table width
  const calculateTableWidth = () => {
    return visibleFields.reduce((total, field) => {
      return total + (columnWidths[field.id] || field.width || 150);
    }, 100); // Add 100 for the last empty column
  };

  // Get available calculation options for a field type
  const getCalculationOptions = (fieldType: FieldType) => {
    switch (fieldType) {
      case 'number':
      case 'currency':
        return [
          { value: 'sum', label: 'Sum', icon: Calculator },
          { value: 'average', label: 'Average', icon: BarChart3 },
          { value: 'min', label: 'Min', icon: ArrowDown },
          { value: 'max', label: 'Max', icon: ArrowUp },
          { value: 'median', label: 'Median', icon: Activity },
          { value: 'range', label: 'Range', icon: ArrowUpDown },
          { value: 'count', label: 'Count values', icon: Hash },
          { value: 'count-empty', label: 'Count empty', icon: Circle },
          { value: 'count-not-empty', label: 'Count not empty', icon: CheckCircle2 },
          { value: 'percent-empty', label: 'Percent empty', icon: Percent },
          { value: 'percent-not-empty', label: 'Percent not empty', icon: Percent },
        ];
      case 'text':
      case 'email':
      case 'phone':
      case 'linkedin':
      case 'twitter':
      case 'domain':
        return [
          { value: 'count', label: 'Count values', icon: Hash },
          { value: 'count-empty', label: 'Count empty', icon: Circle },
          { value: 'count-not-empty', label: 'Count not empty', icon: CheckCircle2 },
          { value: 'percent-empty', label: 'Percent empty', icon: Percent },
          { value: 'percent-not-empty', label: 'Percent not empty', icon: Percent },
          { value: 'count-unique', label: 'Count unique', icon: Layers },
        ];
      case 'checkbox':
        return [
          { value: 'checked', label: 'Checked', icon: CheckSquare },
          { value: 'unchecked', label: 'Unchecked', icon: Square },
          { value: 'percent-checked', label: 'Percent checked', icon: Percent },
        ];
      case 'date':
      case 'due-date':
      case 'completed-on':
      case 'created-on':
      case 'last-modified-on':
        return [
          { value: 'earliest', label: 'Earliest', icon: ArrowUp },
          { value: 'latest', label: 'Latest', icon: ArrowDown },
          { value: 'date-range', label: 'Date range', icon: Calendar },
          { value: 'count', label: 'Count values', icon: Hash },
          { value: 'count-empty', label: 'Count empty', icon: Circle },
          { value: 'count-not-empty', label: 'Count not empty', icon: CheckCircle2 },
        ];
      case 'categories':
      case 'multi-select':
      case 'tags':
        return [
          { value: 'count-unique', label: 'Count unique', icon: Layers },
          { value: 'count-all', label: 'Count all', icon: Hash },
          { value: 'count-empty', label: 'Count empty', icon: Circle },
          { value: 'count-not-empty', label: 'Count not empty', icon: CheckCircle2 },
          { value: 'percent-empty', label: 'Percent empty', icon: Percent },
          { value: 'percent-not-empty', label: 'Percent not empty', icon: Percent },
        ];
      case 'single-select':
      case 'people':
      case 'assignee':
      case 'created-by':
        return [
          { value: 'count', label: 'Count values', icon: Hash },
          { value: 'count-empty', label: 'Count empty', icon: Circle },
          { value: 'count-not-empty', label: 'Count not empty', icon: CheckCircle2 },
          { value: 'count-unique', label: 'Count unique', icon: Layers },
          { value: 'percent-empty', label: 'Percent empty', icon: Percent },
          { value: 'percent-not-empty', label: 'Percent not empty', icon: Percent },
        ];
      default:
        return [
          { value: 'count', label: 'Count values', icon: Hash },
          { value: 'count-empty', label: 'Count empty', icon: Circle },
          { value: 'count-not-empty', label: 'Count not empty', icon: CheckCircle2 },
        ];
    }
  };

  // Apply calculation based on type
  const applyCalculation = (fieldId: string, calculationType: string) => {
    setFieldCalculations(prev => ({ ...prev, [fieldId]: calculationType }));
    toast.success(st('sweep.weldflow.tablePage.appliedCalculation', { type: calculationType }));
  };

  const evaluateFormula = (formula: string, rowData: any): number | string => {
    if (!formula || !rowData) return "";

    try {
      // Replace field names with their values
      let expression = formula;

      // Get all field names and replace them with values
      fields.forEach(field => {
        const fieldName = field.name.toLowerCase().replace(/\s+/g, '_');
        const value = rowData[field.id];

        // Convert value to number if it's a number or currency field
        let numericValue = 0;
        if (field.type === 'number' || field.type === 'currency') {
          numericValue = typeof value === 'number' ? value : parseFloat(value) || 0;
        } else if (typeof value === 'string') {
          numericValue = parseFloat(value) || 0;
        } else if (typeof value === 'number') {
          numericValue = value;
        }

        // Replace field references in the expression (case-insensitive)
        const regex = new RegExp(`\\b${field.name}\\b`, 'gi');
        expression = expression.replace(regex, numericValue.toString());
      });

      // Evaluate the expression safely
      // Only allow basic math operations
      const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, '');
      if (sanitized !== expression) {
        return "Invalid formula";
      }

      const result = Function(`"use strict"; return (${sanitized})`)();

      if (typeof result === 'number' && !isNaN(result)) {
        return Math.round(result * 100) / 100; // Round to 2 decimal places
      }

      return "Error";
    } catch (error) {
      return "Error";
    }
  };

  const calculateRollup = (field: Field, rowData: any): number | string => {
    if (!field.rollupConfig) return 0;

    const { relationField, targetField, aggregation } = field.rollupConfig;

    // Get the relation value (could be a project name, id, etc.)
    const relationValue = rowData[relationField];
    if (!relationValue) return 0;

    // Find all rows that match this relation
    const relatedRows = rows.filter(r => r.data[relationField] === relationValue);

    if (relatedRows.length === 0) return 0;

    // Get values from the target field
    const values = relatedRows
      .map(r => r.data[targetField])
      .filter(v => typeof v === 'number' && !isNaN(v));

    if (values.length === 0) return 0;

    // Perform aggregation
    switch (aggregation) {
      case 'sum':
        return values.reduce((acc, val) => acc + val, 0);
      case 'average':
        return values.reduce((acc, val) => acc + val, 0) / values.length;
      case 'count':
        return values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      default:
        return 0;
    }
  };

  const renderCellContent = (field: Field, value: any, rowData?: any) => {
    switch (field.type) {
      case "formula":
        if (!value) return "";
        const result = evaluateFormula(value, rowData);
        return (
          <span style={{ fontSize: '14px', fontWeight: '600', fontFamily: 'monospace' }}>
            {typeof result === 'number' ? result.toLocaleString('en-US') : result}
          </span>
        );

      case "rollup":
        const rollupResult = calculateRollup(field, rowData);
        return (
          <span style={{ fontSize: '14px', fontWeight: '600', fontFamily: 'monospace' }}>
            {typeof rollupResult === 'number' ? rollupResult.toLocaleString('en-US') : rollupResult}
          </span>
        );

      case "timer":
        return (
          <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>
            {value || "00:00:00"}
          </span>
        );

      case "time-tracking":
        return (
          <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>
            {value || "00:00:00"}
          </span>
        );

      case "text":
        if (field.id === "company" && value) {
          return (
            <>
              <div style={{
                width: '16px',
                height: '16px',
                borderRadius: '4px',
                backgroundColor: value.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '8px',
                color: 'white',
                fontWeight: '600',
                flexShrink: 0
              }}>
                {value.initials}
              </div>
              <span style={{ fontSize: '14px', color: '#111827' }}>{value.name}</span>
            </>
          );
        }
        if (field.id === "twitter" && value) {
          return <span style={{ fontSize: '14px', color: '#3b82f6' }}>{value}</span>;
        }
        if (field.id === "description" && value) {
          return <span style={{ fontSize: '14px', color: '#6b7280' }}>{value}</span>;
        }
        return <span style={{ fontSize: '14px' }}>{value || ""}</span>;

      case "categories":
        if (!value || value.length === 0) return "";
        const displayedCategories = value.slice(0, 2);
        const remainingCount = value.length - 2;
        return (
          <>
            {displayedCategories.map((category: string) => (
              <span
                key={category}
                className={cn(getCategoryStyle(category))}
                style={{
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: '500',
                  flexShrink: 0,
                  maxHeight: '20px',
                  display: 'inline-flex',
                  alignItems: 'center'
                }}
              >
                {category}
              </span>
            ))}
            {remainingCount > 0 && (
              <span style={{ fontSize: '11px', color: '#6b7280', flexShrink: 0 }}>
                +{remainingCount}
              </span>
            )}
          </>
        );

      case "linkedin":
        if (!value) return "";
        return (
          <a
            href={`https://linkedin.com/company/${value}`}
            style={{ fontSize: '14px', color: '#3b82f6', textDecoration: 'none' }}
            target="_blank"
            rel="noopener noreferrer"
            onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'}
            onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
          >
            {value}
          </a>
        );

      case "interaction":
        if (!value) return "";
        return (
          <span style={{
            fontSize: '14px',
            color: value === "No contact" ? '#9ca3af' : '#374151'
          }}>
            {value}
          </span>
        );

      case "status":
        if (!value) return "";
        if (value === "No communication") {
          return (
            <>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#d1d5db',
                border: '1px solid #9ca3af',
                flexShrink: 0
              }} />
              <span style={{ fontSize: '14px', color: '#9ca3af' }}>No communication</span>
            </>
          );
        }
        if (value === "Very weak") {
          return (
            <>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#ef4444',
                flexShrink: 0
              }} />
              <span style={{ fontSize: '14px', color: '#ef4444' }}>Very weak</span>
            </>
          );
        }
        return value;

      case "domain":
        if (!value) return "";
        return (
          <a
            href={`https://${value}`}
            style={{ fontSize: '14px', color: '#3b82f6', textDecoration: 'none' }}
            target="_blank"
            rel="noopener noreferrer"
            onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'}
            onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
          >
            {value}
          </a>
        );

      case "number":
        if (!value && value !== 0) return "";
        return <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>{value.toLocaleString('en-US')}</span>;

      case "currency":
        if (!value && value !== 0) return "";
        return <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>${value.toLocaleString('en-US')}</span>;

      case "date":
      case "due-date":
      case "completed-on":
      case "last-modified-on":
      case "created-on":
        if (!value) return "";
        const date = new Date(value);
        return <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>{date.toLocaleDateString()}</span>;

      case "single-select":
        if (!value) return "";
        return <TagLabel tag={value} />;

      case "multi-select":
      case "tags":
        if (!value || value.length === 0) return "";
        const displayedItems = value.slice(0, 2);
        const remainingItemsCount = value.length - 2;
        return (
          <>
            {displayedItems.map((item: string, index: number) => (
              <TagLabel key={index} tag={item} className="flex-shrink-0" />
            ))}
            {remainingItemsCount > 0 && (
              <span style={{ fontSize: '12px', color: '#6b7280', flexShrink: 0 }}>
                +{remainingItemsCount}
              </span>
            )}
          </>
        );

      case "people":
      case "assignee":
      case "created-by":
        if (!value || !value.name) return "";
        return (
          <>
            <div style={{
              width: '16px',
              height: '16px',
              borderRadius: '4px',
              backgroundColor: getAvatarColor(value.name),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '8px',
              color: 'white',
              fontWeight: '600',
              flexShrink: 0
            }}>
              {value.name?.charAt(0).toUpperCase() || "?"}
            </div>
            <span style={{ fontSize: '14px', color: '#111827' }}>{value.name}</span>
          </>
        );

      case "collaborators":
        if (!value || value.length === 0) return "";
        return (
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', marginLeft: '-2px' }}>
              {value.slice(0, 3).map((person: any, index: number) => {
                const personName = typeof person === 'string' ? person : (person.name || '');
                return (
                  <div
                    key={index}
                    style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '6px',
                      border: '2px solid white',
                      backgroundColor: getAvatarColor(personName),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '9px',
                      color: 'white',
                      fontWeight: '600',
                      marginLeft: index > 0 ? '-4px' : '0',
                      zIndex: 3 - index
                    }}
                  >
                    {personName.charAt(0).toUpperCase() || "?"}
                  </div>
                );
              })}
            </div>
            {value.length > 3 && (
              <span style={{ marginLeft: '4px', fontSize: '12px', color: '#6b7280' }}>
                +{value.length - 3}
              </span>
            )}
          </div>
        );

      default:
        return <span style={{ fontSize: '14px' }}>{value || ""}</span>;
    }
  };

  const visibleFields = fields.filter(field => field.visible !== false);
  const displayedRows = applyFilters(rows);

  return (
    <div className="-m-6 w-[calc(100%+48px)] h-[calc(100vh-64px)] flex flex-col bg-white relative overflow-hidden">
      {/* Table Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between" style={{ minHeight: '48px' }}>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-8 text-sm px-3 shadow-none">
                <ArrowUpDown className="h-4 w-4 mr-1" />
                {st('sweep.weldflow.tablePage.sort')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {visibleFields.map((field) => (
                <DropdownMenuItem key={field.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1">
                    {field.icon && React.createElement(field.icon, { className: "h-4 w-4" })}
                    <span>{field.name}</span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSortColumn(field.id, 'asc');
                        toast.success(st('sweep.weldflow.tablePage.sortedAscending', { field: field.name }));
                      }}
                      className="p-1 hover:bg-muted rounded"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSortColumn(field.id, 'desc');
                        toast.success(st('sweep.weldflow.tablePage.sortedDescending', { field: field.name }));
                      }}
                      className="p-1 hover:bg-muted rounded"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </div>
                </DropdownMenuItem>
              ))}
              {sortConfig.field && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      setSortConfig({ field: null, direction: null });
                      toast.success(st('sweep.weldflow.tablePage.sortCleared'));
                    }}
                  >
                    <X className="h-4 w-4 mr-0.5" />
                    {st('sweep.weldflow.tablePage.clearSort')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-8 text-sm px-3 shadow-none">
                <Filter className="h-4 w-4 mr-1" />
                {st('sweep.weldflow.timeline.filter')}
                {filters.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs bg-primary text-primary-foreground rounded">
                    {filters.length}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-96">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-sm">{st('sweep.weldflow.tablePage.filters')}</h4>
                  {filters.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setFilters([]);
                        toast.success(st('sweep.weldflow.tablePage.allFiltersCleared'));
                      }}
                    >
                      {st('sweep.weldflow.tablePage.clearAll')}
                    </Button>
                  )}
                </div>

                {filters.map((filter, index) => (
                  <div key={filter.id} className="flex gap-2 items-start">
                    <Select
                      value={filter.field}
                      onValueChange={(value) => {
                        setFilters(filters.map((f, i) =>
                          i === index ? { ...f, field: value } : f
                        ));
                      }}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue placeholder={st('sweep.weldflow.tablePage.field')} />
                      </SelectTrigger>
                      <SelectContent>
                        {visibleFields.map((field) => (
                          <SelectItem key={field.id} value={field.id}>
                            {field.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Select
                      value={filter.operator}
                      onValueChange={(value: any) => {
                        setFilters(filters.map((f, i) =>
                          i === index ? { ...f, operator: value } : f
                        ));
                      }}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue placeholder={st('sweep.weldflow.tablePage.operator')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="equals">{st('sweep.weldflow.tablePage.equals')}</SelectItem>
                        <SelectItem value="contains">{st('sweep.weldflow.tablePage.contains')}</SelectItem>
                        <SelectItem value="starts_with">{st('sweep.weldflow.tablePage.startsWith')}</SelectItem>
                        <SelectItem value="ends_with">{st('sweep.weldflow.tablePage.endsWith')}</SelectItem>
                        <SelectItem value="greater_than">{st('sweep.weldflow.tablePage.greaterThan')}</SelectItem>
                        <SelectItem value="less_than">{st('sweep.weldflow.tablePage.lessThan')}</SelectItem>
                        <SelectItem value="is_empty">{st('sweep.weldflow.tablePage.isEmpty')}</SelectItem>
                        <SelectItem value="is_not_empty">{st('sweep.weldflow.tablePage.isNotEmpty')}</SelectItem>
                      </SelectContent>
                    </Select>

                    {filter.operator !== 'is_empty' && filter.operator !== 'is_not_empty' && (
                      <Input
                        placeholder={st('sweep.weldflow.actionConfig.optionValuePlaceholder')}
                        value={filter.value}
                        onChange={(e) => {
                          setFilters(filters.map((f, i) =>
                            i === index ? { ...f, value: e.target.value } : f
                          ));
                        }}
                        className="flex-1"
                      />
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setFilters(filters.filter((_, i) => i !== index));
                        toast.success(st('sweep.weldflow.tablePage.filterRemoved'));
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setFilters([...filters, {
                      id: Date.now().toString(),
                      field: visibleFields[0]?.id || '',
                      operator: 'contains',
                      value: ''
                    }]);
                  }}
                  className="w-full"
                >
                  <Plus className="h-4 w-4 mr-0.5" />
                  {st('sweep.weldflow.tablePage.addFilter')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-8 text-sm px-3 shadow-none">
                <Settings className="h-4 w-4 mr-1" />
                {st('sweep.weldflow.tablePage.viewSettings')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <div className="px-2 py-2 text-xs font-semibold text-muted-foreground">
                {st('sweep.weldflow.tablePage.showHideFields')}
              </div>
              {fields.map((field) => (
                <DropdownMenuItem
                  key={field.id}
                  onClick={(e) => {
                    e.preventDefault();
                    setFields(fields.map(f =>
                      f.id === field.id ? { ...f, visible: !f.visible } : f
                    ));
                  }}
                  className="flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    {field.icon && React.createElement(field.icon, { className: "h-4 w-4" })}
                    <span>{field.name}</span>
                  </div>
                  {field.visible !== false ? (
                    <Eye className="h-4 w-4" />
                  ) : (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="h-8 text-sm px-3 shadow-none">
            <ArrowUpDown className="h-4 w-4 mr-1" />
            {st('sweep.weldflow.tablePage.importExport')}
          </Button>
          <Button
            className="h-8 text-sm px-3 shadow-none"
            onClick={addNewRow}
          >
            <Plus className="h-4 w-4 mr-1" />
            {st('sweep.weldflow.tablePage.newRecord')}
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 bg-white overflow-y-auto" style={{ overflowX: 'hidden' }}>
        <div
          ref={tableScrollRef}
          style={{ overflowX: 'scroll', overflowY: 'visible', scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          onScroll={handleTableScroll}
          className="[&::-webkit-scrollbar]:hidden"
        >
          <table className="border-collapse" style={{ tableLayout: 'fixed', width: `${calculateTableWidth()}px` }}>
          <thead className="bg-white sticky top-0 z-10">
            <tr style={{ height: '40px' }} className="border-b border-gray-200">
              {visibleFields.map((field) => (
                <th
                  key={field.id}
                  className="text-left border-r border-gray-200 font-medium text-sm text-gray-600 bg-white relative"
                  style={{
                    width: columnWidths[field.id] || field.width || 150,
                    minWidth: 50,
                    height: '40px',
                    padding: 0
                  }}
                >
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        className="w-full h-full px-3 flex items-center gap-1.5 hover:bg-gray-50 transition-colors text-left"
                        style={{ height: '40px' }}
                      >
                        {field.icon && React.createElement(field.icon, { className: "h-3.5 w-3.5" })}
                        <span className="text-[13px]">{field.name}</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[200px] p-0" align="start">
                      <Command>
                        <CommandList>
                          <CommandGroup>
                            <CommandItem onSelect={() => {
                              handleSortColumn(field.id, 'asc');
                              toast.success(st('sweep.weldflow.tablePage.sortedAscendingSimple'));
                            }}>
                              <ArrowUp className="mr-0.5 h-4 w-4" />
                              {st('sweep.weldflow.tablePage.sortAscending')}
                            </CommandItem>
                            <CommandItem onSelect={() => {
                              handleSortColumn(field.id, 'desc');
                              toast.success(st('sweep.weldflow.tablePage.sortedDescendingSimple'));
                            }}>
                              <ArrowDown className="mr-0.5 h-4 w-4" />
                              {st('sweep.weldflow.tablePage.sortDescending')}
                            </CommandItem>
                          </CommandGroup>
                          <CommandGroup>
                            <CommandItem
                              onSelect={() => {
                                handleMoveColumn(field.id, 'left');
                                toast.success(st('sweep.weldflow.tablePage.columnMovedLeft'));
                              }}
                              disabled={visibleFields.findIndex(f => f.id === field.id) === 0}
                            >
                              <ArrowLeft className="mr-0.5 h-4 w-4" />
                              {st('sweep.weldflow.tablePage.moveLeft')}
                            </CommandItem>
                            <CommandItem
                              onSelect={() => {
                                handleMoveColumn(field.id, 'right');
                                toast.success(st('sweep.weldflow.tablePage.columnMovedRight'));
                              }}
                              disabled={visibleFields.findIndex(f => f.id === field.id) === visibleFields.length - 1}
                            >
                              <ArrowRight className="mr-0.5 h-4 w-4" />
                              {st('sweep.weldflow.tablePage.moveRight')}
                            </CommandItem>
                          </CommandGroup>
                          <CommandGroup>
                            <CommandItem onSelect={() => {
                              setEditFieldDialog({
                                open: true,
                                fieldId: field.id,
                                name: field.name
                              });
                            }}>
                              <PencilLine className="mr-0.5 h-4 w-4" />
                              {st('sweep.weldflow.tablePage.editColumnLabel')}
                            </CommandItem>
                            {field.type === "checkbox" && (
                              <CommandItem onSelect={() => {
                                setCheckboxLabelDialog({
                                  open: true,
                                  fieldId: field.id,
                                  checkedLabel: field.checkedLabel || st('sweep.weldflow.tablePage.checked'),
                                  uncheckedLabel: field.uncheckedLabel || st('sweep.weldflow.tablePage.unchecked'),
                                });
                              }}>
                                <CheckSquare className="mr-0.5 h-4 w-4" />
                                {st('sweep.weldflow.tablePage.editCheckboxLabels')}
                              </CommandItem>
                            )}
                            <CommandItem onSelect={() => {
                              handleHideColumn(field.id);
                              toast.success(st('sweep.weldflow.tablePage.columnHidden'));
                            }}>
                              <EyeOff className="mr-0.5 h-4 w-4" />
                              {st('sweep.weldflow.tablePage.hideFromView')}
                            </CommandItem>
                          </CommandGroup>
                          <CommandGroup>
                            <CommandItem
                              onSelect={() => {
                                handleDeleteColumn(field.id);
                                toast.success(st('sweep.weldflow.tablePage.columnDeleted'));
                              }}
                              className="text-red-600 focus:text-red-600 focus:bg-red-50"
                            >
                              <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
                              {st('sweep.weldflow.tablePage.deleteColumn')}
                            </CommandItem>
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <div
                    className="absolute right-0 top-0 w-1 h-full cursor-col-resize hover:bg-gray-400 bg-transparent transition-colors"
                    onMouseDown={(e) => handleMouseDown(e, field.id)}
                  />
                </th>
              ))}
              <th className="bg-white px-3" style={{ width: '100px', height: '40px' }}>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      className="h-6 px-2 text-xs text-gray-500"
                    >
                      <Plus className="h-5 w-5 mr-1" />
                      {st('sweep.weldflow.timesheetPage.add')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[240px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder={st('sweep.weldflow.tablePage.searchFieldTypesPlaceholder')} />
                      <CommandList
                        style={{ maxHeight: '500px' }}
                        className="[&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-200 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:bg-gray-300"
                      >
                        <CommandEmpty>{st('sweep.weldflow.tablePage.noFieldTypeFound')}</CommandEmpty>
                        <CommandGroup heading={st('sweep.weldflow.tablePage.selectFieldType')}>
                          {fieldTypeOptions.map((option) => (
                            <CommandItem
                              key={option.value}
                              onSelect={() => {
                                const newField: Field = {
                                  id: `field_${Date.now()}`,
                                  name: option.label,
                                  type: option.value as FieldType,
                                  width: getDefaultWidthForFieldType(option.value as FieldType),
                                  icon: option.icon,
                                  visible: true,
                                };
                                setFields([...fields, newField]);
                                setColumnWidths(prev => ({ ...prev, [newField.id]: getDefaultWidthForFieldType(option.value as FieldType) }));

                                // Add default value to all existing rows
                                setRows(rows.map(row => ({
                                  ...row,
                                  data: {
                                    ...row.data,
                                    [newField.id]: getDefaultValueForFieldType(option.value as FieldType)
                                  }
                                })));

                                toast.success(st('sweep.weldflow.tablePage.addedField', { name: option.label }));
                              }}
                            >
                              <option.icon className="mr-0.5 h-4 w-4" />
                              {option.label}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {displayedRows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  "border-b border-gray-200 transition-colors",
                  hoveredRow === row.id && "bg-gray-50"
                )}
                style={{ height: '40px' }}
                onMouseEnter={() => setHoveredRow(row.id)}
                onMouseLeave={() => setHoveredRow(null)}
              >
                {visibleFields.map((field) => (
                  <td
                    key={field.id}
                    className="border-r border-gray-200 relative"
                    style={{
                      height: '40px',
                      padding: 0,
                      overflow: 'hidden'
                    }}
                  >
                    {/* Text/Number/Email/Phone/Currency fields - editable */}
                    {(field.type === "text" || field.type === "number" || field.type === "email" || field.type === "phone" || field.type === "currency") && (
                      editingCell?.rowId === row.id && editingCell?.fieldId === field.id ? (
                        <CellWrapper>
                          <input
                            style={{
                              width: '100%',
                              height: '28px',
                              padding: '0 8px',
                              fontSize: '14px',
                              border: '2px solid #3b82f6',
                              borderRadius: '4px',
                              outline: 'none'
                            }}
                            type={field.type === "number" || field.type === "currency" ? "number" : field.type === "email" ? "email" : "text"}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveCellEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveCellEdit();
                              if (e.key === "Escape") {
                                setEditingCell(null);
                                setEditValue("");
                              }
                            }}
                            autoFocus
                          />
                        </CellWrapper>
                      ) : (
                        <CellWrapper onClick={() => handleCellEdit(row.id, field.id, row.data[field.id])}>
                          {renderCellContent(field, row.data[field.id], row.data)}
                        </CellWrapper>
                      )
                    )}

                    {/* Checkbox field */}
                    {field.type === "checkbox" && (
                      <CellWrapper
                        onClick={(e) => {
                          // Don't open dialog when clicking the checkbox itself
                          if ((e.target as HTMLElement).closest('[role="checkbox"]')) {
                            return;
                          }
                          setCheckboxLabelDialog({
                            open: true,
                            fieldId: field.id,
                            checkedLabel: field.checkedLabel || "Checked",
                            uncheckedLabel: field.uncheckedLabel || "Unchecked",
                          });
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        <Checkbox
                          checked={row.data[field.id] === true}
                          onCheckedChange={(checked) => {
                            setRows(rows.map(r =>
                              r.id === row.id
                                ? { ...r, data: { ...r.data, [field.id]: checked } }
                                : r
                            ));
                          }}
                          className="mr-2"
                        />
                        <span style={{ fontSize: '14px', color: '#6b7280' }}>
                          {row.data[field.id] === true
                            ? (field.checkedLabel || "Checked")
                            : (field.uncheckedLabel || "Unchecked")}
                        </span>
                      </CellWrapper>
                    )}

                    {/* Date fields */}
                    {(field.type === "date" || field.type === "due-date" || field.type === "completed-on" || field.type === "created-on" || field.type === "last-modified-on") && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <div>
                            <CellWrapper>
                              <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>
                                {row.data[field.id] ? new Date(row.data[field.id]).toLocaleDateString() : ""}
                              </span>
                            </CellWrapper>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <CalendarComponent
                            mode="single"
                            selected={row.data[field.id] ? new Date(row.data[field.id]) : undefined}
                            onSelect={(date) => {
                              if (date) {
                                setRows(rows.map(r =>
                                  r.id === row.id
                                    ? { ...r, data: { ...r.data, [field.id]: date.toISOString().split('T')[0] } }
                                    : r
                                ));
                              }
                            }}
                            className="rounded-md border"
                            captionLayout="dropdown"
                          />
                        </PopoverContent>
                      </Popover>
                    )}

                    {/* Single Select */}
                    {field.type === "single-select" && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <div>
                            <CellWrapper>
                              {renderCellContent(field, row.data[field.id], row.data)}
                            </CellWrapper>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-[250px] p-0">
                          <Command>
                            <CommandList>
                              <CommandGroup>
                                {(field.options || selectOptions).map((option) => (
                                  <CommandItem
                                    key={option}
                                    onSelect={() => {
                                      setRows(rows.map(r =>
                                        r.id === row.id
                                          ? { ...r, data: { ...r.data, [field.id]: option } }
                                          : r
                                      ));
                                    }}
                                    className="justify-between"
                                  >
                                    <TagLabel tag={option} />
                                    {row.data[field.id] === option && (
                                      <div className="ml-2 h-2 w-2 rounded-full bg-primary" />
                                    )}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                              <CommandSeparator />
                              <CommandGroup>
                                <CommandItem
                                  onSelect={() => {
                                    setCreateOptionDialog({
                                      open: true,
                                      fieldId: field.id,
                                      rowId: row.id,
                                      optionName: "",
                                      optionColor: "#3b82f6",
                                    });
                                  }}
                                >
                                  <Plus className="mr-0.5 h-4 w-4" />
                                  {st('sweep.weldflow.tablePage.createNewOptionAction')}
                                </CommandItem>
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    )}

                    {/* Multi Select / Tags */}
                    {(field.type === "multi-select" || field.type === "tags") && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <div>
                            <CellWrapper>
                              {renderCellContent(field, row.data[field.id], row.data)}
                            </CellWrapper>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-[250px] p-0" align="start">
                          <Command>
                            <CommandList>
                              <CommandGroup>
                                {(field.type === "tags" ?
                                  ["bug", "feature", "enhancement", "documentation"] :
                                  ["Option A", "Option B", "Option C", "Option D"]
                                ).map((option) => (
                                  <CommandItem
                                    key={option}
                                    onSelect={() => {
                                      const currentValues = row.data[field.id] || [];
                                      const newValues = currentValues.includes(option)
                                        ? currentValues.filter((v: string) => v !== option)
                                        : [...currentValues, option];
                                      setRows(rows.map(r =>
                                        r.id === row.id
                                          ? { ...r, data: { ...r.data, [field.id]: newValues } }
                                          : r
                                      ));
                                    }}
                                    className="justify-between"
                                  >
                                    <TagLabel tag={option} />
                                    {(row.data[field.id] || []).includes(option) && (
                                      <div className="ml-2 h-2 w-2 rounded-full bg-primary" />
                                    )}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                              <CommandSeparator />
                              <CommandGroup>
                                <CommandItem
                                  onSelect={() => {
                                    setCreateTagDialog({
                                      open: true,
                                      rowId: row.id,
                                      fieldId: field.id,
                                      tagName: "",
                                      tagColor: "#3b82f6"
                                    });
                                  }}
                                >
                                  <Plus className="mr-0.5 h-4 w-4" />
                                  {st('sweep.weldflow.tablePage.createNewTagAction')}
                                </CommandItem>
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    )}

                    {/* People/Assignee */}
                    {(field.type === "people" || field.type === "assignee" || field.type === "created-by") && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <div>
                            <CellWrapper>
                              {renderCellContent(field, row.data[field.id], row.data)}
                            </CellWrapper>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-[250px] p-0" align="start">
                          <Command>
                            <CommandInput placeholder={st('sweep.weldflow.tablePage.searchTeamMembersPlaceholder')} />
                            <CommandList>
                              <CommandGroup>
                                {teamMembers.map((member) => (
                                  <CommandItem
                                    key={member.id}
                                    onSelect={() => {
                                      setRows(rows.map(r =>
                                        r.id === row.id
                                          ? { ...r, data: { ...r.data, [field.id]: member } }
                                          : r
                                      ));
                                    }}
                                    className="justify-between"
                                  >
                                    <div className="flex items-center">
                                      <div
                                        className="w-4 h-4 rounded mr-2"
                                        style={{
                                          backgroundColor: getAvatarColor(member.name),
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          fontSize: '8px',
                                          color: 'white',
                                          fontWeight: '600',
                                          paddingTop: '1px'
                                        }}
                                      >
                                        {member.name[0]}
                                      </div>
                                      {member.name}
                                    </div>
                                    {row.data[field.id]?.id === member.id && (
                                      <div className="h-2 w-2 rounded-full bg-primary" />
                                    )}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    )}

                    {/* Formula field */}
                    {field.type === "formula" && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <div>
                            <CellWrapper>
                              {renderCellContent(field, row.data[field.id], row.data)}
                            </CellWrapper>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-[400px] p-4" align="start">
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <Label>{st('sweep.weldflow.tablePage.formulaExpression')}</Label>
                              <Input
                                value={row.data[field.id] || ""}
                                onChange={(e) => {
                                  setRows(rows.map(r =>
                                    r.id === row.id
                                      ? { ...r, data: { ...r.data, [field.id]: e.target.value } }
                                      : r
                                  ));
                                }}
                                placeholder={st('sweep.weldflow.tablePage.formulaExpressionPlaceholder')}
                                className="font-mono text-sm"
                              />
                              <p className="text-xs text-gray-500">
                                {st('sweep.weldflow.tablePage.formulaExpressionHelp')}
                              </p>
                            </div>
                            {row.data[field.id] && (
                              <div className="pt-3 border-t">
                                <div className="flex items-center justify-between">
                                  <span className="text-sm text-gray-600">{st('sweep.weldflow.tablePage.result')}</span>
                                  <span className="text-sm font-semibold font-mono">
                                    {evaluateFormula(row.data[field.id], row.data)}
                                  </span>
                                </div>
                              </div>
                            )}
                            {row.data[field.id] && (
                              <div className="pt-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="w-full"
                                  onClick={() => {
                                    const currentFormula = row.data[field.id];
                                    setRows(rows.map(r => ({
                                      ...r,
                                      data: { ...r.data, [field.id]: currentFormula }
                                    })));
                                    toast.success(st('sweep.weldflow.tablePage.formulaAppliedToAllRows'));
                                  }}
                                >
                                  {st('sweep.weldflow.tablePage.applyFormulaToAllRows')}
                                </Button>
                              </div>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}

                    {/* Collaborators field */}
                    {field.type === "collaborators" && (
                      <>
                        {(!row.data[field.id] || row.data[field.id].length === 0) ? (
                          <Popover>
                            <PopoverTrigger asChild>
                              <div>
                                <CellWrapper>
                                  {renderCellContent(field, row.data[field.id], row.data)}
                                </CellWrapper>
                              </div>
                            </PopoverTrigger>
                            <PopoverContent className="w-[250px] p-0" align="start">
                              <Command>
                                <CommandInput placeholder={st('sweep.weldflow.tablePage.searchCollaboratorsPlaceholder')} />
                                <CommandList>
                                  <CommandGroup>
                                    {["John Doe", "Jane Smith", "Bob Johnson", "Alice Williams", "Tom Davis", "Sarah Miller"].map((person) => (
                                      <CommandItem
                                        key={person}
                                        onSelect={() => {
                                          const currentCollaborators = row.data[field.id] || [];
                                          const newCollaborators = currentCollaborators.includes(person)
                                            ? currentCollaborators.filter((p: string) => p !== person)
                                            : [...currentCollaborators, person];
                                          setRows(rows.map(r =>
                                            r.id === row.id
                                              ? { ...r, data: { ...r.data, [field.id]: newCollaborators } }
                                              : r
                                          ));
                                        }}
                                        className="justify-between"
                                      >
                                        <div className="flex items-center">
                                          <div
                                            className="w-4 h-4 rounded mr-2"
                                            style={{
                                              backgroundColor: getAvatarColor(person),
                                              display: 'flex',
                                              alignItems: 'center',
                                              justifyContent: 'center',
                                              fontSize: '8px',
                                              color: 'white',
                                              fontWeight: '600',
                                              paddingTop: '1px'
                                            }}
                                          >
                                            {person[0]}
                                          </div>
                                          {person}
                                        </div>
                                        {(row.data[field.id] || []).includes(person) && (
                                          <div className="h-2 w-2 rounded-full bg-primary" />
                                        )}
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        ) : (
                          <TooltipProvider>
                            <Tooltip delayDuration={300}>
                              <Popover>
                                <PopoverTrigger asChild>
                                  <TooltipTrigger asChild>
                                    <div>
                                      <CellWrapper>
                                        {renderCellContent(field, row.data[field.id], row.data)}
                                      </CellWrapper>
                                    </div>
                                  </TooltipTrigger>
                                </PopoverTrigger>
                                <PopoverContent className="w-[250px] p-0" align="start">
                                  <Command>
                                    <CommandInput placeholder={st('sweep.weldflow.tablePage.searchCollaboratorsPlaceholder')} />
                                    <CommandList>
                                      <CommandGroup>
                                        {["John Doe", "Jane Smith", "Bob Johnson", "Alice Williams", "Tom Davis", "Sarah Miller"].map((person) => (
                                          <CommandItem
                                            key={person}
                                            onSelect={() => {
                                              const currentCollaborators = row.data[field.id] || [];
                                              const newCollaborators = currentCollaborators.includes(person)
                                                ? currentCollaborators.filter((p: string) => p !== person)
                                                : [...currentCollaborators, person];
                                              setRows(rows.map(r =>
                                                r.id === row.id
                                                  ? { ...r, data: { ...r.data, [field.id]: newCollaborators } }
                                                  : r
                                              ));
                                            }}
                                            className="justify-between"
                                          >
                                            <div className="flex items-center">
                                              <div
                                                className="w-4 h-4 rounded mr-2"
                                                style={{
                                                  backgroundColor: getAvatarColor(person),
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  justifyContent: 'center',
                                                  fontSize: '8px',
                                                  color: 'white',
                                                  fontWeight: '600',
                                                  paddingTop: '1px'
                                                }}
                                              >
                                                {person[0]}
                                              </div>
                                              {person}
                                            </div>
                                            {(row.data[field.id] || []).includes(person) && (
                                              <div className="h-2 w-2 rounded-full bg-primary" />
                                            )}
                                          </CommandItem>
                                        ))}
                                      </CommandGroup>
                                    </CommandList>
                                  </Command>
                                </PopoverContent>
                              </Popover>
                              <TooltipContent side="top" align="start">
                                <div className="flex flex-col gap-1">
                                  {(row.data[field.id] || []).map((person: any, index: number) => {
                                    const personName = typeof person === 'string' ? person : (person.name || '');
                                    return (
                                      <div key={index} className="text-sm">{personName}</div>
                                    );
                                  })}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </>
                    )}

                    {/* Projects field */}
                    {field.type === "projects" && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <div>
                            <CellWrapper>
                              {renderCellContent(field, row.data[field.id], row.data)}
                            </CellWrapper>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-[200px] p-0">
                          <Command>
                            <CommandInput placeholder={st('sweep.weldflow.tablePage.searchProjectsPlaceholder')} />
                            <CommandList>
                              <CommandGroup>
                                {projectsList.map((project) => (
                                  <CommandItem
                                    key={project}
                                    onSelect={() => {
                                      setRows(rows.map(r =>
                                        r.id === row.id
                                          ? { ...r, data: { ...r.data, [field.id]: project } }
                                          : r
                                      ));
                                    }}
                                  >
                                    {project}
                                    {row.data[field.id] === project && (
                                      <Check className="ml-auto h-4 w-4" />
                                    )}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    )}

                    {/* Timer field (countdown) */}
                    {field.type === "timer" && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <div>
                            <CellWrapper>
                              <div className="flex items-center justify-between gap-2 w-full">
                                <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>
                                  {row.data[field.id] || "00:00:00"}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="bg-gray-100 dark:bg-secondary rounded p-1 hover:bg-gray-200 dark:hover:bg-accent transition-colors"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const timerKey = `${row.id}-${field.id}`;
                                    const currentTimer = runningTimers[timerKey];

                                    if (currentTimer) {
                                      // Stop countdown
                                      const remaining = currentTimer.elapsed - (Date.now() - currentTimer.startTime);
                                      const totalSeconds = Math.max(0, Math.floor(remaining / 1000));
                                      const hours = Math.floor(totalSeconds / 3600);
                                      const minutes = Math.floor((totalSeconds % 3600) / 60);
                                      const seconds = totalSeconds % 60;
                                      const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

                                      setRows(rows.map(r =>
                                        r.id === row.id
                                          ? { ...r, data: { ...r.data, [field.id]: timeString } }
                                          : r
                                      ));

                                      setRunningTimers(prev => {
                                        const newTimers = { ...prev };
                                        delete newTimers[timerKey];
                                        return newTimers;
                                      });
                                    } else {
                                      // Start countdown
                                      const currentValue = row.data[field.id] || "00:00:00";
                                      const [hours, minutes, seconds] = currentValue.split(':').map(Number);
                                      const totalMs = (hours * 3600000) + (minutes * 60000) + (seconds * 1000);

                                      if (totalMs > 0) {
                                        setRunningTimers(prev => ({
                                          ...prev,
                                          [timerKey]: { startTime: Date.now(), elapsed: totalMs }
                                        }));
                                      }
                                    }
                                  }}
                                >
                                  {runningTimers[`${row.id}-${field.id}`] ? (
                                    <Square className="h-3.5 w-3.5 text-red-600 fill-red-600" />
                                  ) : (
                                    <Play className="h-3.5 w-3.5 text-black dark:text-white" />
                                  )}
                                </Button>
                              </div>
                            </CellWrapper>
                          </div>
                        </PopoverTrigger>
                        <PopoverContent className="w-[300px] p-4">
                          <div className="space-y-4">
                            <Label>{st('sweep.weldflow.tablePage.setTimerDuration')}</Label>
                            <div className="flex gap-2">
                              <div className="flex-1">
                                <Input
                                  type="number"
                                  placeholder={st('sweep.weldflow.tablePage.hoursAbbreviation')}
                                  min="0"
                                  max="99"
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      const hours = parseInt((e.target as HTMLInputElement).value) || 0;
                                      const minutes = parseInt(((e.target as HTMLInputElement).parentElement?.querySelector('input:nth-child(2)') as HTMLInputElement)?.value || '0') || 0;
                                      const seconds = parseInt(((e.target as HTMLInputElement).parentElement?.querySelector('input:nth-child(3)') as HTMLInputElement)?.value || '0') || 0;
                                      const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
                                      setRows(rows.map(r =>
                                        r.id === row.id
                                          ? { ...r, data: { ...r.data, [field.id]: timeString } }
                                          : r
                                      ));
                                    }
                                  }}
                                />
                              </div>
                              <div className="flex-1">
                                <Input
                                  type="number"
                                  placeholder={st('sweep.weldflow.tablePage.minutesAbbreviation')}
                                  min="0"
                                  max="59"
                                />
                              </div>
                              <div className="flex-1">
                                <Input
                                  type="number"
                                  placeholder={st('sweep.weldflow.tablePage.secondsAbbreviation')}
                                  min="0"
                                  max="59"
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <Button
                                variant="outline"
                                className="w-full"
                                onClick={() => {
                                  const inputs = document.querySelectorAll(`input[type="number"]`);
                                  const hours = parseInt((inputs[0] as HTMLInputElement).value) || 0;
                                  const minutes = parseInt((inputs[1] as HTMLInputElement).value) || 0;
                                  const seconds = parseInt((inputs[2] as HTMLInputElement).value) || 0;
                                  const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
                                  setRows(rows.map(r => ({
                                    ...r,
                                    data: { ...r.data, [field.id]: timeString }
                                  })));
                                  toast.success(st('sweep.weldflow.tablePage.timerSetForAllRows'));
                                }}
                              >
                                {st('sweep.weldflow.tablePage.setForAllRows')}
                              </Button>
                              <Button
                                className="w-full"
                                onClick={() => {
                                  const inputs = document.querySelectorAll(`input[type="number"]`);
                                  const hours = parseInt((inputs[0] as HTMLInputElement).value) || 0;
                                  const minutes = parseInt((inputs[1] as HTMLInputElement).value) || 0;
                                  const seconds = parseInt((inputs[2] as HTMLInputElement).value) || 0;
                                  const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
                                  setRows(rows.map(r =>
                                    r.id === row.id
                                      ? { ...r, data: { ...r.data, [field.id]: timeString } }
                                      : r
                                  ));
                                  toast.success(st('sweep.weldflow.tablePage.timerSet'));
                                }}
                              >
                                {st('sweep.weldflow.tablePage.setTimer')}
                              </Button>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}

                    {/* Time tracking field (count up) */}
                    {field.type === "time-tracking" && (
                      <CellWrapper>
                        <div className="flex items-center justify-between gap-2 w-full">
                          <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>
                            {row.data[field.id] || "00:00:00"}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="bg-gray-100 dark:bg-secondary rounded p-1 hover:bg-gray-200 dark:hover:bg-accent transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              const timerKey = `${row.id}-${field.id}`;
                              const currentTimer = runningTimers[timerKey];

                              if (currentTimer) {
                                // Stop tracking
                                const elapsed = currentTimer.elapsed + (Date.now() - currentTimer.startTime);
                                const hours = Math.floor(elapsed / 3600000);
                                const minutes = Math.floor((elapsed % 3600000) / 60000);
                                const seconds = Math.floor((elapsed % 60000) / 1000);
                                const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

                                setRows(rows.map(r =>
                                  r.id === row.id
                                    ? { ...r, data: { ...r.data, [field.id]: timeString } }
                                    : r
                                ));

                                setRunningTimers(prev => {
                                  const newTimers = { ...prev };
                                  delete newTimers[timerKey];
                                  return newTimers;
                                });
                              } else {
                                // Start tracking
                                const currentValue = row.data[field.id] || "00:00:00";
                                const [hours, minutes, seconds] = currentValue.split(':').map(Number);
                                const elapsed = (hours * 3600000) + (minutes * 60000) + (seconds * 1000);

                                setRunningTimers(prev => ({
                                  ...prev,
                                  [timerKey]: { startTime: Date.now(), elapsed }
                                }));
                              }
                            }}
                          >
                            {runningTimers[`${row.id}-${field.id}`] ? (
                              <Square className="h-3.5 w-3.5 text-red-600 fill-red-600" />
                            ) : (
                              <Play className="h-3.5 w-3.5 text-black dark:text-white" />
                            )}
                          </Button>
                        </div>
                      </CellWrapper>
                    )}

                    {/* Rollup field */}
                    {field.type === "rollup" && (
                      <CellWrapper>
                        <Popover>
                          <PopoverTrigger asChild>
                            <div className="flex items-center justify-center w-full h-full cursor-pointer hover:bg-muted/50">
                              {renderCellContent(field, row.data[field.id], row.data)}
                            </div>
                          </PopoverTrigger>
                          <PopoverContent className="w-80" align="start">
                            <div className="space-y-4">
                              <div>
                                <Label className="text-xs text-muted-foreground mb-2">Relation Field</Label>
                                <Command className="rounded-lg border">
                                  <CommandList>
                                    <CommandGroup>
                                      {visibleFields.map((f) => (
                                        <CommandItem
                                          key={f.id}
                                          onSelect={() => {
                                            setFields(fields.map(field2 =>
                                              field2.id === field.id
                                                ? {
                                                    ...field2,
                                                    rollupConfig: {
                                                      relationField: f.id,
                                                      targetField: field2.rollupConfig?.targetField || '',
                                                      aggregation: field2.rollupConfig?.aggregation || 'sum'
                                                    }
                                                  }
                                                : field2
                                            ));
                                          }}
                                          className="cursor-pointer"
                                        >
                                          <div className="flex items-center justify-between w-full">
                                            <span>{f.name}</span>
                                            {field.rollupConfig?.relationField === f.id && (
                                              <div className="h-2 w-2 rounded-full bg-primary" />
                                            )}
                                          </div>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </div>

                              <div>
                                <Label className="text-xs text-muted-foreground mb-2">Target Field</Label>
                                <Command className="rounded-lg border">
                                  <CommandList>
                                    <CommandGroup>
                                      {visibleFields.filter(f => f.type === 'number' || f.type === 'currency').map((f) => (
                                        <CommandItem
                                          key={f.id}
                                          onSelect={() => {
                                            setFields(fields.map(field2 =>
                                              field2.id === field.id
                                                ? {
                                                    ...field2,
                                                    rollupConfig: {
                                                      relationField: field2.rollupConfig?.relationField || '',
                                                      targetField: f.id,
                                                      aggregation: field2.rollupConfig?.aggregation || 'sum'
                                                    }
                                                  }
                                                : field2
                                            ));
                                          }}
                                          className="cursor-pointer"
                                        >
                                          <div className="flex items-center justify-between w-full">
                                            <span>{f.name}</span>
                                            {field.rollupConfig?.targetField === f.id && (
                                              <div className="h-2 w-2 rounded-full bg-primary" />
                                            )}
                                          </div>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </div>

                              <div>
                                <Label className="text-xs text-muted-foreground mb-2">Aggregation</Label>
                                <Command className="rounded-lg border">
                                  <CommandList>
                                    <CommandGroup>
                                      {(['sum', 'average', 'count', 'min', 'max'] as const).map((agg) => (
                                        <CommandItem
                                          key={agg}
                                          onSelect={() => {
                                            setFields(fields.map(field2 =>
                                              field2.id === field.id
                                                ? {
                                                    ...field2,
                                                    rollupConfig: {
                                                      relationField: field2.rollupConfig?.relationField || '',
                                                      targetField: field2.rollupConfig?.targetField || '',
                                                      aggregation: agg
                                                    }
                                                  }
                                                : field2
                                            ));
                                          }}
                                          className="cursor-pointer"
                                        >
                                          <div className="flex items-center justify-between w-full">
                                            <span className="capitalize">{agg}</span>
                                            {field.rollupConfig?.aggregation === agg && (
                                              <div className="h-2 w-2 rounded-full bg-primary" />
                                            )}
                                          </div>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </div>
                            </div>
                          </PopoverContent>
                        </Popover>
                      </CellWrapper>
                    )}

                    {/* All other field types - read only for now */}
                    {!["text", "number", "email", "phone", "currency", "checkbox", "date", "due-date", "completed-on", "created-on", "last-modified-on", "single-select", "multi-select", "tags", "people", "assignee", "created-by", "formula", "collaborators", "projects", "timer", "time-tracking", "rollup"].includes(field.type) && (
                      <CellWrapper>
                        {renderCellContent(field, row.data[field.id], row.data)}
                      </CellWrapper>
                    )}
                  </td>
                ))}
                <td style={{ height: '40px', padding: 0 }}></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* Footer with Calculations */}
      <div className="bg-white border-t border-gray-200" style={{ height: '40px', overflowX: 'hidden' }}>
        <div
          ref={footerScrollRef}
          style={{ overflowX: 'scroll', overflowY: 'visible', scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          className="[&::-webkit-scrollbar]:hidden"
        >
          <table className="border-collapse" style={{ tableLayout: 'fixed', width: `${calculateTableWidth()}px` }}>
            <tbody>
              <tr style={{ height: '40px' }}>
                {visibleFields.map((field) => {
                  let calculation = '';

                  // Calculate based on field type
                  if (field.type === 'number' || field.type === 'currency') {
                    const sum = rows.reduce((total, row) => {
                      const value = row.data[field.id];
                      return total + (typeof value === 'number' ? value : 0);
                    }, 0);
                    calculation = field.type === 'currency'
                      ? `$${sum.toLocaleString('en-US')}`
                      : sum.toLocaleString('en-US');
                  } else if (field.type === 'categories' || field.type === 'multi-select' || field.type === 'tags') {
                    const uniqueItems = new Set();
                    rows.forEach(row => {
                      const value = row.data[field.id];
                      if (Array.isArray(value)) {
                        value.forEach(item => uniqueItems.add(item));
                      }
                    });
                    calculation = `${uniqueItems.size} unique`;
                  } else if (field.type === 'checkbox') {
                    const checkedCount = rows.filter(row => row.data[field.id] === true).length;
                    calculation = `${checkedCount} checked`;
                  }

                  return (
                    <td
                      key={field.id}
                      className="border-r border-gray-200 px-3"
                      style={{
                        width: columnWidths[field.id] || field.width || 150,
                        height: '40px',
                        fontSize: '13px',
                        color: '#6b7280',
                        fontWeight: '500'
                      }}
                    >
                      {calculation || (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="ghost"
                              className="flex items-center gap-1 text-gray-400 hover:text-gray-600 transition-colors"
                              style={{ fontSize: '13px' }}
                            >
                              <Plus className="h-3 w-3" />
                              {st('sweep.weldflow.tablePage.addCalculation')}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[220px] p-0 [&_*]:!overflow-visible" align="start" style={{ overflow: 'visible' }}>
                            <div style={{ overflow: 'visible' }}>
                              <CommandGroup heading={st('sweep.weldflow.tablePage.calculate')} className="p-2">
                                {getCalculationOptions(field.type).map((option) => (
                                  <CommandItem
                                    key={option.value}
                                    onSelect={() => {
                                      applyCalculation(field.id, option.value);
                                    }}
                                    className="cursor-pointer"
                                  >
                                    <option.icon className="mr-0.5 h-4 w-4" />
                                    {option.label}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}
                    </td>
                  );
                })}
                <td style={{ width: '100px', height: '40px' }}>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Horizontal Scrollbar */}
      <div
        ref={scrollbarRef}
        className="bg-gray-50 border-t border-gray-200 overflow-x-auto overflow-y-hidden"
        style={{ height: '16px' }}
        onScroll={handleScrollbarScroll}
      >
        <div style={{ width: `${calculateTableWidth()}px`, height: '1px' }} />
      </div>

      {/* Edit Field Name Dialog */}
      <Dialog open={editFieldDialog.open} onOpenChange={(open) => {
        if (!open) {
          setEditFieldDialog({ open: false, fieldId: "", name: "" });
        }
      }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.tablePage.editColumnLabel')}</DialogTitle>
            <DialogDescription>
              {st('sweep.weldflow.tablePage.editColumnLabelDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-field-name">
                {st('sweep.weldflow.tablePage.columnName')}
              </Label>
              <Input
                id="edit-field-name"
                value={editFieldDialog.name}
                onChange={(e) => setEditFieldDialog(prev => ({ ...prev, name: e.target.value }))}
                placeholder={st('sweep.weldflow.tablePage.enterColumnNamePlaceholder')}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditFieldDialog({ open: false, fieldId: "", name: "" })}
            >
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (editFieldDialog.name && editFieldDialog.fieldId) {
                  handleEditFieldName(editFieldDialog.fieldId, editFieldDialog.name);
                  setEditFieldDialog({ open: false, fieldId: "", name: "" });
                  toast.success(st('sweep.weldflow.tablePage.columnLabelUpdated'));
                }
              }}
              disabled={!editFieldDialog.name}
            >
              {st('sweep.weldflow.analyticsView.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Tag Dialog */}
      <Dialog open={createTagDialog.open} onOpenChange={(open) => {
        if (!open) {
          setCreateTagDialog({ open: false, rowId: "", fieldId: "", tagName: "", tagColor: "#3b82f6" });
        }
      }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.tablePage.createNewTag')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="tag-name">
                {st('sweep.weldflow.tablePage.tagName')}
              </Label>
              <Input
                id="tag-name"
                value={createTagDialog.tagName}
                onChange={(e) => setCreateTagDialog(prev => ({ ...prev, tagName: e.target.value }))}
                placeholder={st('sweep.weldflow.tablePage.enterTagNamePlaceholder')}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && createTagDialog.tagName.trim()) {
                    const currentValues = rows.find(r => r.id === createTagDialog.rowId)?.data[createTagDialog.fieldId] || [];
                    const newValues = [...currentValues, createTagDialog.tagName.trim()];
                    setRows(rows.map(r =>
                      r.id === createTagDialog.rowId
                        ? { ...r, data: { ...r.data, [createTagDialog.fieldId]: newValues } }
                        : r
                    ));
                    toast.success(st('sweep.weldflow.tablePage.createdAndAddedTag', { name: createTagDialog.tagName.trim() }));
                    setCreateTagDialog({ open: false, rowId: "", fieldId: "", tagName: "", tagColor: "#3b82f6" });
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tag-color">
                {st('sweep.weldflow.tablePage.color')}
              </Label>
              <div className="flex gap-2 flex-wrap">
                {[
                  "#3b82f6", // blue
                  "#ef4444", // red
                  "#10b981", // green
                  "#f59e0b", // amber
                  "#8b5cf6", // purple
                  "#ec4899", // pink
                  "#06b6d4", // cyan
                  "#64748b", // slate
                ].map((color) => (
                  <Button
                    key={color}
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setCreateTagDialog(prev => ({ ...prev, tagColor: color }))}
                    className="w-8 h-8 rounded-md border-2 transition-all hover:scale-110"
                    style={{
                      backgroundColor: color,
                      borderColor: createTagDialog.tagColor === color ? "#000" : "transparent"
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateTagDialog({ open: false, rowId: "", fieldId: "", tagName: "", tagColor: "#3b82f6" })}
            >
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (createTagDialog.tagName.trim() && createTagDialog.rowId && createTagDialog.fieldId) {
                  const currentValues = rows.find(r => r.id === createTagDialog.rowId)?.data[createTagDialog.fieldId] || [];
                  const newValues = [...currentValues, createTagDialog.tagName.trim()];
                  setRows(rows.map(r =>
                    r.id === createTagDialog.rowId
                      ? { ...r, data: { ...r.data, [createTagDialog.fieldId]: newValues } }
                      : r
                  ));
                  toast.success(st('sweep.weldflow.tablePage.createdAndAddedTag', { name: createTagDialog.tagName.trim() }));
                  setCreateTagDialog({ open: false, rowId: "", fieldId: "", tagName: "", tagColor: "#3b82f6" });
                }
              }}
              disabled={!createTagDialog.tagName.trim()}
            >
              {st('sweep.weldflow.tablePage.createTag')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Checkbox Labels Dialog */}
      <Dialog open={checkboxLabelDialog.open} onOpenChange={(open) => {
        if (!open) {
          setCheckboxLabelDialog({ open: false, fieldId: "", checkedLabel: "Checked", uncheckedLabel: "Unchecked" });
        }
      }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.tablePage.editCheckboxLabels')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="checked-label">{st('sweep.weldflow.tablePage.checkedLabel')}</Label>
              <Input
                id="checked-label"
                value={checkboxLabelDialog.checkedLabel}
                onChange={(e) => setCheckboxLabelDialog(prev => ({ ...prev, checkedLabel: e.target.value }))}
                placeholder={st('sweep.weldflow.tablePage.enterCheckedLabelPlaceholder')}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="unchecked-label">{st('sweep.weldflow.tablePage.uncheckedLabel')}</Label>
              <Input
                id="unchecked-label"
                value={checkboxLabelDialog.uncheckedLabel}
                onChange={(e) => setCheckboxLabelDialog(prev => ({ ...prev, uncheckedLabel: e.target.value }))}
                placeholder={st('sweep.weldflow.tablePage.enterUncheckedLabelPlaceholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCheckboxLabelDialog({ open: false, fieldId: "", checkedLabel: "Checked", uncheckedLabel: "Unchecked" });
              }}
            >
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (checkboxLabelDialog.fieldId) {
                  setFields(fields.map(f =>
                    f.id === checkboxLabelDialog.fieldId
                      ? { ...f, checkedLabel: checkboxLabelDialog.checkedLabel, uncheckedLabel: checkboxLabelDialog.uncheckedLabel }
                      : f
                  ));
                  toast.success(st('sweep.weldflow.tablePage.checkboxLabelsUpdated'));
                  setCheckboxLabelDialog({ open: false, fieldId: "", checkedLabel: "Checked", uncheckedLabel: "Unchecked" });
                }
              }}
            >
              {st('sweep.weldflow.analyticsView.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create New Option Dialog */}
      <Dialog open={createOptionDialog.open} onOpenChange={(open) => {
        if (!open) {
          setCreateOptionDialog({ open: false, fieldId: "", rowId: "", optionName: "", optionColor: "#3b82f6" });
        }
      }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.tablePage.createNewOption')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="option-name">{st('sweep.weldflow.tablePage.optionName')}</Label>
              <Input
                id="option-name"
                value={createOptionDialog.optionName}
                onChange={(e) => setCreateOptionDialog(prev => ({ ...prev, optionName: e.target.value }))}
                placeholder={st('sweep.weldflow.tablePage.enterOptionNamePlaceholder')}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && createOptionDialog.optionName.trim()) {
                    // Add the new option to the field
                    const field = fields.find(f => f.id === createOptionDialog.fieldId);
                    if (field) {
                      const currentOptions = field.options || selectOptions;
                      const newOptions = [...currentOptions, createOptionDialog.optionName.trim()];
                      setFields(fields.map(f =>
                        f.id === createOptionDialog.fieldId
                          ? { ...f, options: newOptions }
                          : f
                      ));
                      // Set this option as the value for the row
                      setRows(rows.map(r =>
                        r.id === createOptionDialog.rowId
                          ? { ...r, data: { ...r.data, [createOptionDialog.fieldId]: createOptionDialog.optionName.trim() } }
                          : r
                      ));
                      toast.success(st('sweep.weldflow.tablePage.createdAndSelectedOption', { name: createOptionDialog.optionName.trim() }));
                      setCreateOptionDialog({ open: false, fieldId: "", rowId: "", optionName: "", optionColor: "#3b82f6" });
                    }
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="option-color">{st('sweep.weldflow.tablePage.color')}</Label>
              <div className="flex gap-2 flex-wrap">
                {["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#64748b"].map((color) => (
                  <Button
                    key={color}
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setCreateOptionDialog(prev => ({ ...prev, optionColor: color }))}
                    className="w-8 h-8 rounded-md border-2 transition-all hover:scale-110"
                    style={{
                      backgroundColor: color,
                      borderColor: createOptionDialog.optionColor === color ? "#000" : "transparent"
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOptionDialog({ open: false, fieldId: "", rowId: "", optionName: "", optionColor: "#3b82f6" });
              }}
            >
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (createOptionDialog.optionName.trim() && createOptionDialog.fieldId) {
                  // Add the new option to the field
                  const field = fields.find(f => f.id === createOptionDialog.fieldId);
                  if (field) {
                    const currentOptions = field.options || selectOptions;
                    const newOptions = [...currentOptions, createOptionDialog.optionName.trim()];
                    setFields(fields.map(f =>
                      f.id === createOptionDialog.fieldId
                        ? { ...f, options: newOptions }
                        : f
                    ));
                    // Set this option as the value for the row
                    setRows(rows.map(r =>
                      r.id === createOptionDialog.rowId
                        ? { ...r, data: { ...r.data, [createOptionDialog.fieldId]: createOptionDialog.optionName.trim() } }
                        : r
                    ));
                    toast.success(st('sweep.weldflow.tablePage.createdAndSelectedOption', { name: createOptionDialog.optionName.trim() }));
                    setCreateOptionDialog({ open: false, fieldId: "", rowId: "", optionName: "", optionColor: "#3b82f6" });
                  }
                }
              }}
              disabled={!createOptionDialog.optionName.trim()}
            >
              {st('sweep.weldflow.tablePage.createOption')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}