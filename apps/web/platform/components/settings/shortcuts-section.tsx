
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Search, Keyboard, Info } from "lucide-react"
import { Button } from "@weldsuite/ui/components/button"
import { FilterPills, type ActiveFilter, type FilterConfig } from "@/components/entity-list"
import { cn } from "@/lib/utils"
import { ExpandingSearchInput } from "@/components/settings/expanding-search-input"

const shortcuts = {
  "General": [
    { keys: ["⌘", "K"], description: "Open command palette" },
    { keys: ["⌘", ","], description: "Open settings" },
    { keys: ["⌘", "/"], description: "Show keyboard shortcuts" },
    { keys: ["Esc"], description: "Close dialog / Cancel" },
    { keys: ["⌘", "Z"], description: "Undo" },
    { keys: ["⌘", "Shift", "Z"], description: "Redo" },
  ],
  "Navigation": [
    { keys: ["⌘", "1"], description: "Go to Dashboard" },
    { keys: ["⌘", "2"], description: "Go to Commerce" },
    { keys: ["⌘", "3"], description: "Go to WMS" },
    { keys: ["⌘", "4"], description: "Go to CRM" },
    { keys: ["⌘", "5"], description: "Go to Accounting" },
    { keys: ["Alt", "←"], description: "Navigate back" },
    { keys: ["Alt", "→"], description: "Navigate forward" },
  ],
  "Commerce": [
    { keys: ["⌘", "N"], description: "Create new product" },
    { keys: ["⌘", "Shift", "N"], description: "Create new order" },
    { keys: ["⌘", "E"], description: "Edit selected item" },
    { keys: ["⌘", "D"], description: "Duplicate selected item" },
    { keys: ["Delete"], description: "Delete selected item" },
    { keys: ["⌘", "S"], description: "Save changes" },
  ],
  "Search & Filter": [
    { keys: ["⌘", "F"], description: "Focus search field" },
    { keys: ["⌘", "Shift", "F"], description: "Advanced search" },
    { keys: ["⌘", "G"], description: "Find next" },
    { keys: ["⌘", "Shift", "G"], description: "Find previous" },
    { keys: ["Esc"], description: "Clear search" },
  ],
  "Tables & Lists": [
    { keys: ["↑"], description: "Move selection up" },
    { keys: ["↓"], description: "Move selection down" },
    { keys: ["Space"], description: "Select/Deselect item" },
    { keys: ["⌘", "A"], description: "Select all" },
    { keys: ["⌘", "Shift", "A"], description: "Deselect all" },
    { keys: ["Enter"], description: "Open selected item" },
  ],
  "Workspace": [
    { keys: ["⌘", "Shift", "W"], description: "Switch workspace" },
    { keys: ["⌘", "Shift", "U"], description: "Manage users" },
    { keys: ["⌘", "Shift", "S"], description: "Workspace settings" },
    { keys: ["⌘", "L"], description: "Lock workspace" },
  ],
  "Developer": [
    { keys: ["⌘", "Shift", "D"], description: "Toggle developer tools" },
    { keys: ["⌘", "Shift", "C"], description: "Copy debug info" },
    { keys: ["⌘", "Option", "I"], description: "Inspect element" },
    { keys: ["⌘", "Shift", "P"], description: "Performance monitor" },
  ]
}

export function ShortcutsSection() {
  const t = useTranslations()
  const [searchQuery, setSearchQuery] = React.useState("")  const [activeFilters, setActiveFilters] = React.useState<ActiveFilter[]>([])
  const filterConfigs: FilterConfig[] = React.useMemo(() => [
    {
      field: 'category',
      label: 'Category',
      filterType: 'select',
      searchable: true,
      options: Object.keys(shortcuts).map((c) => ({ value: c, label: c })),
    },
  ], [])

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
            item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
            item.keys.some(key => key.toLowerCase().includes(searchQuery.toLowerCase()))
          )
      if (filtered.length > 0) {
        (acc as typeof shortcuts)[category as keyof typeof shortcuts] = filtered
      }
      return acc
    }, {} as typeof shortcuts)
  }, [searchQuery, activeFilters])

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
            <h4 className="text-sm font-semibold text-muted-foreground">{category}</h4>
            <div className="rounded-lg border">
              <div className="divide-y">
                {items.map((shortcut, index) => (
                  <div key={index} className="flex items-center justify-between p-3">
                    <span className="text-sm">{shortcut.description}</span>
                    <div className="flex items-center gap-1.5">
                      {shortcut.keys.map((key, keyIndex) => (
                        <React.Fragment key={keyIndex}>
                          {keyIndex > 0 && <span className="text-base text-muted-foreground -translate-y-[2px] ml-[0.3px] inline-block">+</span>}
                          <kbd className={cn(
                            "inline-flex items-center justify-center rounded-[6px]",
                            "bg-muted text-muted-foreground text-xs font-medium",
                            "border border-border",
                            key.length === 1
                              ? "h-[26px] w-[26px] p-0"
                              : "h-[26px] px-2 py-0",
                          )}>
                            {key === '⌘' ? (
                              <span className="inline-block scale-150 leading-none translate-y-[0.5px]">{key}</span>
                            ) : ['↑', '↓', '←', '→'].includes(key) ? (
                              <span className="text-[19px] leading-none -translate-y-[2.5px] inline-block">{key}</span>
                            ) : key.length === 1 ? (
                              <span className="text-[13px] leading-none -translate-y-px inline-block">{key}</span>
                            ) : (
                              key
                            )}
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
