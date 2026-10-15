
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Keyboard, Info } from "lucide-react"
import { FilterPills, type ActiveFilter, type FilterConfig } from "@/components/entity-list"
import { cn } from "@/lib/utils"
import { ExpandingSearchInput } from "@/components/settings/expanding-search-input"
import { useI18n } from '@/lib/i18n/provider'
import type { TranslationNamespaces } from '@/lib/i18n'

type ShortcutStrings = TranslationNamespaces['settings']['shortcutsList']
type ShortcutCategory = keyof ShortcutStrings['categories']
type ShortcutId = keyof ShortcutStrings['items']
type ShortcutDefinition = { keys: string[]; id: ShortcutId }

const shortcuts: Record<ShortcutCategory, ShortcutDefinition[]> = {
  general: [
    { keys: ["⌘", "K"], id: 'openCommandPalette' },
    { keys: ["⌘", ","], id: 'openSettings' },
    { keys: ["⌘", "/"], id: 'showKeyboardShortcuts' },
    { keys: ["Esc"], id: 'closeDialogCancel' },
    { keys: ["⌘", "Z"], id: 'undo' },
    { keys: ["⌘", "Shift", "Z"], id: 'redo' },
  ],
  navigation: [
    { keys: ["⌘", "1"], id: 'goToDashboard' },
    { keys: ["⌘", "2"], id: 'goToCommerce' },
    { keys: ["⌘", "3"], id: 'goToWms' },
    { keys: ["⌘", "4"], id: 'goToCrm' },
    { keys: ["⌘", "5"], id: 'goToAccounting' },
    { keys: ["Alt", "←"], id: 'navigateBack' },
    { keys: ["Alt", "→"], id: 'navigateForward' },
  ],
  commerce: [
    { keys: ["⌘", "N"], id: 'createNewProduct' },
    { keys: ["⌘", "Shift", "N"], id: 'createNewOrder' },
    { keys: ["⌘", "E"], id: 'editSelectedItem' },
    { keys: ["⌘", "D"], id: 'duplicateSelectedItem' },
    { keys: ["Delete"], id: 'deleteSelectedItem' },
    { keys: ["⌘", "S"], id: 'saveChanges' },
  ],
  searchAndFilter: [
    { keys: ["⌘", "F"], id: 'focusSearchField' },
    { keys: ["⌘", "Shift", "F"], id: 'advancedSearch' },
    { keys: ["⌘", "G"], id: 'findNext' },
    { keys: ["⌘", "Shift", "G"], id: 'findPrevious' },
    { keys: ["Esc"], id: 'clearSearch' },
  ],
  tablesAndLists: [
    { keys: ["↑"], id: 'moveSelectionUp' },
    { keys: ["↓"], id: 'moveSelectionDown' },
    { keys: ["Space"], id: 'selectDeselectItem' },
    { keys: ["⌘", "A"], id: 'selectAll' },
    { keys: ["⌘", "Shift", "A"], id: 'deselectAll' },
    { keys: ["Enter"], id: 'openSelectedItem' },
  ],
  workspace: [
    { keys: ["⌘", "Shift", "W"], id: 'switchWorkspace' },
    { keys: ["⌘", "Shift", "U"], id: 'manageUsers' },
    { keys: ["⌘", "Shift", "S"], id: 'workspaceSettings' },
    { keys: ["⌘", "L"], id: 'lockWorkspace' },
  ],
  developer: [
    { keys: ["⌘", "Shift", "D"], id: 'toggleDeveloperTools' },
    { keys: ["⌘", "Shift", "C"], id: 'copyDebugInfo' },
    { keys: ["⌘", "Option", "I"], id: 'inspectElement' },
    { keys: ["⌘", "Shift", "P"], id: 'performanceMonitor' },
  ],
}

function renderShortcutKey(key: string): React.ReactNode {
  if (key === '⌘') {
    return <span className="inline-block scale-150 leading-none translate-y-[0.5px]">{key}</span>
  }
  if (['↑', '↓', '←', '→'].includes(key)) {
    return <span className="text-[19px] leading-none -translate-y-[2.5px] inline-block">{key}</span>
  }
  if (key.length === 1) {
    return <span className="text-[13px] leading-none -translate-y-px inline-block">{key}</span>
  }
  return key
}

export function ShortcutsSection() {
  const t = useTranslations()
  const { t: i18n } = useI18n()
  const sl = i18n.settings.shortcutsList
  const [searchQuery, setSearchQuery] = React.useState("")
  const [activeFilters, setActiveFilters] = React.useState<ActiveFilter[]>([])
  const filterConfigs: FilterConfig[] = React.useMemo(() => [
    {
      field: 'category',
      label: sl.categoryFilter,
      filterType: 'select',
      searchable: true,
      options: Object.keys(shortcuts).map((c) => ({ value: c, label: sl.categories[c as ShortcutCategory] })),
    },
  ], [sl])

  const filteredShortcuts = React.useMemo(() => {
    const allowedCategories = activeFilters
      .filter((f) => f.field === 'category' && f.value)
      .map((f) => f.value)
    return Object.entries(shortcuts).reduce((acc, [category, items]) => {
      if (allowedCategories.length > 0 && !allowedCategories.includes(category)) {
        return acc
      }
      const filtered = !searchQuery
        ? items
        : items.filter(item =>
            sl.items[item.id].toLowerCase().includes(searchQuery.toLowerCase()) ||
            item.keys.some(key => key.toLowerCase().includes(searchQuery.toLowerCase()))
          )
      if (filtered.length > 0) {
        acc[category] = filtered
      }
      return acc
    }, {} as Record<string, ShortcutDefinition[]>)
  }, [searchQuery, activeFilters, sl])

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.shortcuts.title')}</h1>
        <p className="text-muted-foreground">{t('sweep.settings.shortcuts.description')}</p>
      </div>

      <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />
        </div>
        <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={t('sweep.settings.shortcuts.searchPlaceholder')} />
      </div>

      <div className="space-y-10">
        {Object.entries(filteredShortcuts).map(([category, items]) => (
          <div key={category} className="space-y-3">
            <h4 className="text-sm font-semibold text-muted-foreground">{sl.categories[category as ShortcutCategory]}</h4>
            <div className="rounded-lg border">
              <div className="divide-y">
                {items.map((shortcut) => (
                  <div key={shortcut.id} className="flex items-center justify-between p-3">
                    <span className="text-sm">{sl.items[shortcut.id]}</span>
                    <div className="flex items-center gap-1.5">
                      {shortcut.keys.map((key, keyIndex) => (
                        <React.Fragment key={key}>
                          {keyIndex > 0 && <span className="text-base text-muted-foreground -translate-y-[2px] ml-[0.3px] inline-block">+</span>}
                          <kbd className={cn(
                            "inline-flex items-center justify-center rounded-[6px]",
                            "bg-muted text-muted-foreground text-xs font-medium",
                            "border border-border",
                            key.length === 1
                              ? "h-[26px] w-[26px] p-0"
                              : "h-[26px] px-2 py-0",
                          )}>
                            {renderShortcutKey(key)}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
        {Object.keys(filteredShortcuts).length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <Keyboard className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{t('sweep.settings.shortcuts.noneFound')}</p>
            <p className="text-xs">{t('sweep.settings.shortcuts.tryDifferentSearch')}</p>
          </div>
        )}
      </div>

      <div className="rounded-lg bg-muted/50 p-4">
        <div className="flex items-start gap-2">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p>• {t('sweep.settings.shortcuts.tipCmdCtrl')}</p>
            <p>• {t('sweep.settings.shortcuts.tipVaryByOs')}</p>
            <p>• {t('sweep.settings.shortcuts.tipCustomize')}</p>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
