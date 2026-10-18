import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Keyboard } from "lucide-react"
import { shortcutKeyLabels } from "@weldsuite/ui/lib/shortcut"
import { FilterPills, type ActiveFilter, type FilterConfig } from "@/components/entity-list"
import { cn } from "@/lib/utils"
import { ExpandingSearchInput } from "@/components/settings/expanding-search-input"
import { useI18n } from '@/lib/i18n/provider'
import {
  HOTKEYS,
  HOTKEY_CATEGORIES,
  bindingKeys,
  type HotkeyBinding,
  type HotkeyCategory,
} from "@/lib/hotkeys/registry"

/** The keys of a binding as shown on this platform: "⌘ K" on a Mac, "Ctrl K" elsewhere. */
function bindingLabels(binding: HotkeyBinding): string[] {
  return shortcutKeyLabels(bindingKeys(binding))
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

function ShortcutKeys({ labels }: Readonly<{ labels: string[] }>) {
  return (
    <div className="flex items-center gap-1.5">
      {labels.map((key, keyIndex) => (
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
  )
}

export function ShortcutsSection() {
  const t = useTranslations()
  const { t: i18n } = useI18n()
  const sl = i18n.settings.shortcutsList
  const [searchQuery, setSearchQuery] = React.useState("")
  const [activeFilters, setActiveFilters] = React.useState<ActiveFilter[]>([])

  // Labels per hotkey, resolved once for this platform.
  const rows = React.useMemo(
    () =>
      Object.values(HOTKEYS).map((hotkey) => ({
        hotkey,
        labels: bindingLabels(hotkey.binding),
        alternateLabels: hotkey.alternate ? bindingLabels(hotkey.alternate) : null,
      })),
    [],
  )

  const filterConfigs: FilterConfig[] = React.useMemo(() => [
    {
      field: 'category',
      label: sl.categoryFilter,
      filterType: 'select',
      searchable: true,
      options: HOTKEY_CATEGORIES.map((c) => ({ value: c, label: sl.categories[c] })),
    },
  ], [sl])

  const filteredShortcuts = React.useMemo(() => {
    const allowedCategories = activeFilters
      .filter((f) => f.field === 'category' && f.value)
      .map((f) => f.value)
    const query = searchQuery.toLowerCase()
    return HOTKEY_CATEGORIES.reduce((acc, category) => {
      if (allowedCategories.length > 0 && !allowedCategories.includes(category)) {
        return acc
      }
      const inCategory = rows.filter((row) => row.hotkey.category === category)
      const filtered = !query
        ? inCategory
        : inCategory.filter((row) =>
            sl.items[row.hotkey.id].toLowerCase().includes(query) ||
            [...row.labels, ...(row.alternateLabels ?? [])].some((key) => key.toLowerCase().includes(query))
          )
      if (filtered.length > 0) {
        acc.push([category, filtered])
      }
      return acc
    }, [] as [HotkeyCategory, typeof rows][])
  }, [searchQuery, activeFilters, sl, rows])

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
        {filteredShortcuts.map(([category, items]) => (
          <div key={category} className="space-y-3">
            <h4 className="text-sm font-semibold text-muted-foreground">{sl.categories[category]}</h4>
            <div className="rounded-lg border">
              <div className="divide-y">
                {items.map(({ hotkey, labels, alternateLabels }) => (
                  <div key={hotkey.id} className="flex items-center justify-between gap-3 p-3">
                    <span className="text-sm">{sl.items[hotkey.id]}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <ShortcutKeys labels={labels} />
                      {alternateLabels && (
                        <>
                          <span className="text-xs text-muted-foreground">{sl.or}</span>
                          <ShortcutKeys labels={alternateLabels} />
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
        {filteredShortcuts.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <Keyboard className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{t('sweep.settings.shortcuts.noneFound')}</p>
            <p className="text-xs">{t('sweep.settings.shortcuts.tryDifferentSearch')}</p>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}
