
import React, { createContext, useContext, useState, useEffect } from 'react';

export type ModuleType =
  | 'tasks'
  | 'notes'
  | 'pipeline'
  | 'analytics'
  | 'documents'
  | 'chat'
  | 'whiteboard'
  | 'calendar';

interface Module {
  id: string;
  type: ModuleType;
  name: string;
  icon?: string;
}

interface Pipeline {
  id: string;
  name: string;
  color?: string;
  modules: Module[];
  createdAt: Date;
}

interface Space {
  id: string;
  name: string;
  color?: string;
  modules: Module[];
  createdAt: Date;
}

/** Shape persisted to `localStorage` — `createdAt` round-trips as an ISO string. */
interface StoredPipeline {
  id: string;
  name: string;
  color?: string;
  modules?: Module[];
  createdAt: string;
}

/** Shape persisted to `localStorage` — `createdAt` round-trips as an ISO string. */
interface StoredSpace {
  id: string;
  name: string;
  color?: string;
  modules?: Module[];
  createdAt: string;
}

interface PipelinesContextType {
  pipelines: Pipeline[];
  activePipelineId: string | null;
  createPipeline: (name: string) => Pipeline;
  updatePipeline: (id: string, updates: Partial<Pipeline>) => void;
  deletePipeline: (id: string) => void;
  addModuleToPipeline: (pipelineId: string, moduleType: ModuleType) => void;
  removeModuleFromPipeline: (pipelineId: string, moduleId: string) => void;
  setActivePipeline: (id: string | null) => void;
}

interface SpacesContextType {
  spaces: Space[];
  activeSpaceId: string | null;
  createSpace: (name: string) => Space;
  updateSpace: (id: string, updates: Partial<Space>) => void;
  deleteSpace: (id: string) => void;
  addModuleToSpace: (spaceId: string, moduleType: ModuleType) => void;
  removeModuleFromSpace: (spaceId: string, moduleId: string) => void;
  setActiveSpace: (id: string | null) => void;
}

const PipelinesContext = createContext<PipelinesContextType | undefined>(undefined);
const SpacesContext = createContext<SpacesContextType | undefined>(undefined);

const moduleTemplates: Record<ModuleType, { name: string; icon: string }> = {
  tasks: { name: 'Tasks', icon: 'ClipboardList' },
  notes: { name: 'Notes', icon: 'StickyNote' },
  pipeline: { name: 'Pipeline', icon: 'TrendingUp' },
  analytics: { name: 'Analytics', icon: 'BarChart3' },
  documents: { name: 'Documents', icon: 'FileText' },
  chat: { name: 'Chat', icon: 'MessageSquare' },
};

function PipelinesProvider({ children }: { children: React.ReactNode }) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load from localStorage after mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('crm-pipelines');
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setPipelines((parsed as StoredPipeline[]).map((pipeline) => ({
            ...pipeline,
            modules: pipeline.modules || [], // Ensure modules array exists
            createdAt: new Date(pipeline.createdAt)
          })));
        }
      }
      setIsLoaded(true);
    }
  }, []);

  // Save to localStorage whenever pipelines change (but only after initial load)
  useEffect(() => {
    if (typeof window !== 'undefined' && isLoaded) {
      localStorage.setItem('crm-pipelines', JSON.stringify(pipelines));
    }
  }, [pipelines, isLoaded]);

  const createPipeline = (name: string): Pipeline => {
    // Use a deterministic color based on the pipeline name
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
    const colorIndex = name.length % colors.length;
    
    // Generate a more stable ID
    const timestamp = typeof window !== 'undefined' ? Date.now() : 0;
    const newPipeline: Pipeline = {
      id: `pipeline-${timestamp}-${name.replace(/\s+/g, '-').toLowerCase()}`,
      name,
      color: colors[colorIndex],
      modules: [], // Always initialize with empty array
      createdAt: new Date(),
    };
    setPipelines(prev => [...prev, newPipeline]);
    return newPipeline;
  };

  const updatePipeline = (id: string, updates: Partial<Pipeline>) => {
    setPipelines(prev => prev.map(pipeline => 
      pipeline.id === id 
        ? { ...pipeline, ...updates, modules: updates.modules || pipeline.modules || [] } 
        : pipeline
    ));
  };

  const deletePipeline = (id: string) => {
    setPipelines(prev => prev.filter(pipeline => pipeline.id !== id));
    if (activePipelineId === id) {
      setActivePipelineId(null);
    }
  };

  const addModuleToPipeline = (pipelineId: string, moduleType: ModuleType) => {
    const template = moduleTemplates[moduleType];
    const timestamp = typeof window !== 'undefined' ? Date.now() : 0;
    const newModule: Module = {
      id: `module-${timestamp}-${moduleType}`,
      type: moduleType,
      name: template.name,
      icon: template.icon,
    };

    setPipelines(prev => prev.map(pipeline => 
      pipeline.id === pipelineId 
        ? { ...pipeline, modules: [...pipeline.modules, newModule] }
        : pipeline
    ));
  };

  const removeModuleFromPipeline = (pipelineId: string, moduleId: string) => {
    setPipelines(prev => prev.map(pipeline => 
      pipeline.id === pipelineId 
        ? { ...pipeline, modules: pipeline.modules.filter(m => m.id !== moduleId) }
        : pipeline
    ));
  };

  const setActivePipeline = (id: string | null) => {
    setActivePipelineId(id);
  };

  return (
    <PipelinesContext.Provider value={{
      pipelines,
      activePipelineId,
      createPipeline,
      updatePipeline,
      deletePipeline,
      addModuleToPipeline,
      removeModuleFromPipeline,
      setActivePipeline,
    }}>
      {children}
    </PipelinesContext.Provider>
  );
}

// Spaces Provider
export function SpacesProvider({ children }: { children: React.ReactNode }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load from localStorage after mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('crm-spaces');
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setSpaces((parsed as StoredSpace[]).map((space) => ({
            ...space,
            modules: space.modules || [], // Ensure modules array exists
            createdAt: new Date(space.createdAt)
          })));
        }
      }
      setIsLoaded(true);
    }
  }, []);

  // Save to localStorage whenever spaces change (but only after initial load)
  useEffect(() => {
    if (typeof window !== 'undefined' && isLoaded) {
      localStorage.setItem('crm-spaces', JSON.stringify(spaces));
    }
  }, [spaces, isLoaded]);

  const createSpace = (name: string): Space => {
    // Use a deterministic color based on the space name
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
    const colorIndex = name.length % colors.length;
    
    // Generate a more stable ID
    const timestamp = typeof window !== 'undefined' ? Date.now() : 0;
    const newSpace: Space = {
      id: `space-${timestamp}-${name.replace(/\s+/g, '-').toLowerCase()}`,
      name,
      color: colors[colorIndex],
      modules: [], // Always initialize with empty array
      createdAt: new Date(),
    };
    setSpaces(prev => [...prev, newSpace]);
    return newSpace;
  };

  const updateSpace = (id: string, updates: Partial<Space>) => {
    setSpaces(prev => prev.map(space => 
      space.id === id 
        ? { ...space, ...updates, modules: updates.modules || space.modules || [] } 
        : space
    ));
  };

  const deleteSpace = (id: string) => {
    setSpaces(prev => prev.filter(space => space.id !== id));
    if (activeSpaceId === id) {
      setActiveSpaceId(null);
    }
  };

  const addModuleToSpace = (spaceId: string, moduleType: ModuleType) => {
    const template = moduleTemplates[moduleType];
    const timestamp = typeof window !== 'undefined' ? Date.now() : 0;
    const newModule: Module = {
      id: `module-${timestamp}-${moduleType}`,
      type: moduleType,
      name: template.name,
      icon: template.icon,
    };

    setSpaces(prev => prev.map(space => 
      space.id === spaceId 
        ? { ...space, modules: [...space.modules, newModule] }
        : space
    ));
  };

  const removeModuleFromSpace = (spaceId: string, moduleId: string) => {
    setSpaces(prev => prev.map(space => 
      space.id === spaceId 
        ? { ...space, modules: space.modules.filter(m => m.id !== moduleId) }
        : space
    ));
  };

  const setActiveSpace = (id: string | null) => {
    setActiveSpaceId(id);
  };

  // Wrap both providers
  return (
    <PipelinesProvider>
      <SpacesContext.Provider value={{
        spaces,
        activeSpaceId,
        createSpace,
        updateSpace,
        deleteSpace,
        addModuleToSpace,
        removeModuleFromSpace,
        setActiveSpace,
      }}>
        {children}
      </SpacesContext.Provider>
    </PipelinesProvider>
  );
}

export function useSpaces() {
  const context = useContext(SpacesContext);
  if (context === undefined) {
    throw new Error('useSpaces must be used within a SpacesProvider');
  }
  return context;
}