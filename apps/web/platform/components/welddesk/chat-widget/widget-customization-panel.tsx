
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import {
  ColorPicker,
} from '@weldsuite/ui/components/color-picker';
import {
  ChevronDown,
  ChevronRight,
  Info,
  RotateCcw
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import React, { useState, useCallback, useRef } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';

interface WidgetCustomizationPanelProps {
  settings: WidgetThemeSettings;
  onSettingsChange: (settings: WidgetThemeSettings) => void;
}

export interface WidgetThemeSettings {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  buttonColor: string;
  buttonTextColor: string;
  borderRadius: string;
  fontSize: string;
  launcherColor: string;
  headerColor: string;
  accentColor: string;
  startingPage: string;
  companyLogoUrl: string;
  // Chat interface colors
  chatBackgroundColor: string;
  userBubbleColor: string;
  userBubbleTextColor: string;
  agentBubbleColor: string;
  agentBubbleTextColor: string;
}

// Color input with popover color picker
const ColorInput = React.memo(function ColorInput({
  label,
  description,
  value,
  onChange
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs font-normal text-gray-700 dark:text-muted-foreground">{label}</Label>
        {description && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                  <Info className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[200px] text-xs">
                {description}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <ColorPicker value={value} onChange={onChange} />
    </div>
  );
});

// Property section component
const PropertySection = React.memo(function PropertySection({
  id,
  title,
  isExpanded,
  onToggle,
  children
}: {
  id: string;
  title: string;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-gray-200 dark:border-border">
      <Button
        type="button"
        variant="ghost"
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-background/50 transition-colors"
      >
        <span className="text-xs font-medium text-gray-900 dark:text-foreground">{title}</span>
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-gray-500 dark:text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-500 dark:text-muted-foreground" />
        )}
      </Button>
      {isExpanded && (
        <div className="px-4 pb-4 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
});

const DEFAULT_COLORS = {
  primaryColor: '#3B82F6',
  buttonColor: '#3B82F6',
  chatBackgroundColor: '#FFFFFF',
  userBubbleColor: '#000000',
  userBubbleTextColor: '#FFFFFF',
  agentBubbleColor: '#F5F5F5',
  agentBubbleTextColor: '#000000',
};

export function WidgetCustomizationPanel({ settings, onSettingsChange }: WidgetCustomizationPanelProps) {
  const t = useTranslations();
  const [expandedSections, setExpandedSections] = useState<string[]>(['styling', 'typography', 'behavior']);

  // Refs to keep callbacks stable so React.memo on ColorInput works
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onSettingsChangeRef = useRef(onSettingsChange);
  onSettingsChangeRef.current = onSettingsChange;

  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections(prev =>
      prev.includes(sectionId)
        ? prev.filter(id => id !== sectionId)
        : [...prev, sectionId]
    );
  }, []);

  // Memoize per-key handlers so each ColorInput gets a stable onChange reference
  const changeHandlersRef = useRef<Record<string, (value: string) => void>>({});
  const getChangeHandler = useCallback((key: keyof WidgetThemeSettings) => {
    if (!changeHandlersRef.current[key]) {
      changeHandlersRef.current[key] = (value: string) => {
        onSettingsChangeRef.current({ ...settingsRef.current, [key]: value });
      };
    }
    return changeHandlersRef.current[key];
  }, []);

  const handleResetColors = useCallback(() => {
    onSettingsChangeRef.current({
      ...settingsRef.current,
      ...DEFAULT_COLORS,
    });
  }, []);

  const isSectionExpanded = (id: string) => expandedSections.includes(id);

  return (
    <div className="w-[320px] h-full bg-white dark:bg-black border-l border-gray-200 dark:border-border overflow-y-auto flex-shrink-0" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(156, 163, 175, 0.3) transparent' }}>
      {/* Styling Section */}
      <PropertySection
        id="styling"
        title={t('sweep.welddesk.widgetCustomization.stylingSectionTitle')}
        isExpanded={isSectionExpanded('styling')}
        onToggle={toggleSection}
      >
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.launcherColorLabel')}
          description={t('sweep.welddesk.widgetCustomization.launcherColorDescription')}
          value={settings.launcherColor}
          onChange={getChangeHandler('launcherColor')}
        />
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.primaryColorLabel')}
          description={t('sweep.welddesk.widgetCustomization.primaryColorDescription')}
          value={settings.primaryColor}
          onChange={getChangeHandler('primaryColor')}
        />
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.accentColorLabel')}
          description={t('sweep.welddesk.widgetCustomization.accentColorDescription')}
          value={settings.accentColor}
          onChange={getChangeHandler('accentColor')}
        />
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.buttonColorLabel')}
          description={t('sweep.welddesk.widgetCustomization.buttonColorDescription')}
          value={settings.buttonColor}
          onChange={getChangeHandler('buttonColor')}
        />
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.buttonTextColorLabel')}
          description={t('sweep.welddesk.widgetCustomization.buttonTextColorDescription')}
          value={settings.buttonTextColor}
          onChange={getChangeHandler('buttonTextColor')}
        />
        <div className="pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleResetColors}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            {t('sweep.welddesk.widgetCustomization.resetColorsButton')}
          </Button>
        </div>
      </PropertySection>

      {/* Chat Section */}
      <PropertySection
        id="chat"
        title={t('sweep.welddesk.widgetCustomization.chatSectionTitle')}
        isExpanded={isSectionExpanded('chat')}
        onToggle={toggleSection}
      >
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.chatBackgroundLabel')}
          description={t('sweep.welddesk.widgetCustomization.chatBackgroundDescription')}
          value={settings.chatBackgroundColor}
          onChange={getChangeHandler('chatBackgroundColor')}
        />
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.userBubbleColorLabel')}
          description={t('sweep.welddesk.widgetCustomization.userBubbleColorDescription')}
          value={settings.userBubbleColor}
          onChange={getChangeHandler('userBubbleColor')}
        />
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.userBubbleTextLabel')}
          description={t('sweep.welddesk.widgetCustomization.userBubbleTextDescription')}
          value={settings.userBubbleTextColor}
          onChange={getChangeHandler('userBubbleTextColor')}
        />
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.agentBubbleColorLabel')}
          description={t('sweep.welddesk.widgetCustomization.agentBubbleColorDescription')}
          value={settings.agentBubbleColor}
          onChange={getChangeHandler('agentBubbleColor')}
        />
        <ColorInput
          label={t('sweep.welddesk.widgetCustomization.agentBubbleTextLabel')}
          description={t('sweep.welddesk.widgetCustomization.agentBubbleTextDescription')}
          value={settings.agentBubbleTextColor}
          onChange={getChangeHandler('agentBubbleTextColor')}
        />
      </PropertySection>

      {/* Typography Section */}
    </div>
  );
}
