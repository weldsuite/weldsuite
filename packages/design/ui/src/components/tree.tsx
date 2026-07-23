import * as React from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

// Context for tree state management
interface TreeContextValue {
  expandedIds: Set<string>;
  selectedIds: Set<string>;
  toggleExpanded: (id: string) => void;
  toggleSelected: (id: string) => void;
  isExpanded: (id: string) => boolean;
  isSelected: (id: string) => boolean;
}

const TreeContext = React.createContext<TreeContextValue | undefined>(undefined);

function useTreeContext() {
  const context = React.useContext(TreeContext);
  if (!context) {
    throw new Error('Tree components must be used within a TreeProvider');
  }
  return context;
}

// TreeProvider
interface TreeProviderProps {
  children: React.ReactNode;
  defaultExpandedIds?: string[];
  defaultSelectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  onExpansionChange?: (ids: string[]) => void;
}

export function TreeProvider({
  children,
  defaultExpandedIds = [],
  defaultSelectedIds = [],
  onSelectionChange,
  onExpansionChange,
}: TreeProviderProps) {
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(
    new Set(defaultExpandedIds),
  );
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    new Set(defaultSelectedIds),
  );

  const toggleExpanded = React.useCallback(
    (id: string) => {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        onExpansionChange?.(Array.from(next));
        return next;
      });
    },
    [onExpansionChange],
  );

  const toggleSelected = React.useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        onSelectionChange?.(Array.from(next));
        return next;
      });
    },
    [onSelectionChange],
  );

  const isExpanded = React.useCallback(
    (id: string) => expandedIds.has(id),
    [expandedIds],
  );

  const isSelected = React.useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  const value = React.useMemo(
    () => ({
      expandedIds,
      selectedIds,
      toggleExpanded,
      toggleSelected,
      isExpanded,
      isSelected,
    }),
    [expandedIds, selectedIds, toggleExpanded, toggleSelected, isExpanded, isSelected],
  );

  return <TreeContext.Provider value={value}>{children}</TreeContext.Provider>;
}

// TreeView
interface TreeViewProps {
  children: React.ReactNode;
  className?: string;
}

export function TreeView({ children, className }: TreeViewProps) {
  return (
    <div className={cn('text-sm', className)} role="tree">
      {children}
    </div>
  );
}

// TreeNode
interface TreeNodeProps {
  children: React.ReactNode;
  nodeId: string;
  level?: number;
  isLast?: boolean;
  className?: string;
}

const TreeNodeContext = React.createContext<{
  nodeId: string;
  level: number;
  isLast: boolean;
} | null>(null);

export function TreeNode({
  children,
  nodeId,
  level = 0,
  isLast = false,
  className,
}: TreeNodeProps) {
  return (
    <TreeNodeContext.Provider value={{ nodeId, level, isLast }}>
      <div className={cn('relative', className)} role="treeitem">
        {children}
      </div>
    </TreeNodeContext.Provider>
  );
}

// TreeNodeTrigger
interface TreeNodeTriggerProps {
  children: React.ReactNode;
  className?: string;
}

export function TreeNodeTrigger({ children, className }: TreeNodeTriggerProps) {
  const nodeContext = React.useContext(TreeNodeContext);
  const treeContext = useTreeContext();

  if (!nodeContext) {
    throw new Error('TreeNodeTrigger must be used within a TreeNode');
  }

  const { nodeId, level } = nodeContext;
  const isSelected = treeContext.isSelected(nodeId);

  return (
    <div
      className={cn(
        'group flex items-center gap-1 py-1 px-1 rounded-sm cursor-pointer hover:bg-muted/50 transition-colors',
        isSelected && 'bg-muted',
        className,
      )}
      style={{ paddingLeft: `${level * 16}px` }}
      onClick={() => treeContext.toggleSelected(nodeId)}
    >
      {children}
    </div>
  );
}

// TreeNodeContent
interface TreeNodeContentProps {
  children: React.ReactNode;
  hasChildren?: boolean;
  className?: string;
}

export function TreeNodeContent({
  children,
  hasChildren = false,
  className,
}: TreeNodeContentProps) {
  const nodeContext = React.useContext(TreeNodeContext);
  const treeContext = useTreeContext();

  if (!nodeContext) {
    throw new Error('TreeNodeContent must be used within a TreeNode');
  }

  const { nodeId } = nodeContext;
  const isExpanded = treeContext.isExpanded(nodeId);

  if (!hasChildren || !isExpanded) {
    return null;
  }

  return <div className={cn('', className)}>{children}</div>;
}

// TreeExpander
interface TreeExpanderProps {
  hasChildren?: boolean;
  className?: string;
}

export function TreeExpander({ hasChildren = false, className }: TreeExpanderProps) {
  const nodeContext = React.useContext(TreeNodeContext);
  const treeContext = useTreeContext();

  if (!nodeContext) {
    throw new Error('TreeExpander must be used within a TreeNode');
  }

  const { nodeId } = nodeContext;
  const isExpanded = treeContext.isExpanded(nodeId);

  if (!hasChildren) {
    return <span className={cn('w-4 h-4 flex-shrink-0', className)} />;
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        treeContext.toggleExpanded(nodeId);
      }}
      className={cn(
        'w-4 h-4 flex-shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground transition-transform',
        isExpanded && 'rotate-90',
        className,
      )}
    >
      <ChevronRight className="h-3.5 w-3.5" />
    </button>
  );
}

// TreeIcon
interface TreeIconProps {
  hasChildren?: boolean;
  icon?: React.ReactNode;
  className?: string;
}

export function TreeIcon({ hasChildren = false, icon, className }: TreeIconProps) {
  const nodeContext = React.useContext(TreeNodeContext);
  const treeContext = useTreeContext();

  if (!nodeContext) {
    throw new Error('TreeIcon must be used within a TreeNode');
  }

  const { nodeId } = nodeContext;
  const isExpanded = treeContext.isExpanded(nodeId);

  if (icon) {
    return (
      <span className={cn('flex-shrink-0 text-muted-foreground', className)}>{icon}</span>
    );
  }

  if (hasChildren) {
    return isExpanded ? (
      <FolderOpen className={cn('h-4 w-4 flex-shrink-0 text-purple-500', className)} />
    ) : (
      <Folder className={cn('h-4 w-4 flex-shrink-0 text-purple-500', className)} />
    );
  }

  return null;
}

// TreeLabel
interface TreeLabelProps {
  children: React.ReactNode;
  className?: string;
}

export function TreeLabel({ children, className }: TreeLabelProps) {
  return <span className={cn('truncate select-none', className)}>{children}</span>;
}
