"use client"

import * as React from "react"
import { ChevronDown, X } from "lucide-react"

import { cn } from "@weldsuite/ui/lib/utils"
import { Badge } from "@weldsuite/ui/components/badge"
import { Button } from "@weldsuite/ui/components/button"
import { Checkbox } from "@weldsuite/ui/components/checkbox"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@weldsuite/ui/components/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@weldsuite/ui/components/popover"

export interface MultiSelectOption {
  /** Stable value stored in the selection array. */
  value: string
  /** Human-readable label shown in the list and chips; also what search matches on. */
  label: string
  /** Optional leading icon rendered in the list and chip. */
  icon?: React.ReactNode
  /** Disable selecting/deselecting this option. */
  disabled?: boolean
}

export interface MultiSelectProps {
  options: MultiSelectOption[]
  /** Currently selected option values (controlled). */
  value: string[]
  onChange: (value: string[]) => void
  /** Shown in the trigger when nothing is selected. */
  placeholder?: string
  /** Placeholder for the search box. */
  searchPlaceholder?: string
  /** Shown when the search yields no options. */
  emptyText?: string
  /** Whether the search box is shown. Defaults to true. */
  searchable?: boolean
  disabled?: boolean
  /** Max chips to render before collapsing the rest into a "+N" badge. */
  maxDisplay?: number
  /** Class for the trigger button. */
  className?: string
  /** Class for the popover content. */
  contentClassName?: string
  id?: string
  "aria-label"?: string
}

/**
 * MultiSelect — a general-purpose multi-select combobox.
 *
 * A trigger button shows the selected options as removable chips; a popover
 * exposes a searchable, checkbox-driven list. Controlled via `value`/`onChange`.
 * Built on the shared Popover + Command + Checkbox primitives.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  searchable = true,
  disabled = false,
  maxDisplay,
  className,
  contentClassName,
  id,
  "aria-label": ariaLabel,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false)
  const selected = value ?? []

  const optionByValue = React.useMemo(() => {
    const map = new Map<string, MultiSelectOption>()
    for (const option of options) map.set(option.value, option)
    return map
  }, [options])

  const toggle = (optionValue: string) => {
    onChange(
      selected.includes(optionValue)
        ? selected.filter((v) => v !== optionValue)
        : [...selected, optionValue]
    )
  }

  const remove = (optionValue: string) => {
    onChange(selected.filter((v) => v !== optionValue))
  }

  const visibleChips =
    typeof maxDisplay === "number" ? selected.slice(0, maxDisplay) : selected
  const overflowCount = selected.length - visibleChips.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "h-auto min-h-9 w-full justify-between gap-2 px-3 py-2",
            className
          )}
        >
          <span className="flex flex-1 flex-wrap items-center gap-1 overflow-hidden">
            {selected.length === 0 ? (
              <span className="text-muted-foreground font-normal">
                {placeholder}
              </span>
            ) : (
              <>
                {visibleChips.map((v) => {
                  const option = optionByValue.get(v)
                  return (
                    <Badge
                      key={v}
                      variant="secondary"
                      className="gap-1 pr-1 font-normal"
                    >
                      {option?.icon}
                      {option?.label ?? v}
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label={`Remove ${option?.label ?? v}`}
                        className="hover:bg-muted-foreground/20 ml-0.5 inline-flex size-3.5 items-center justify-center rounded-sm"
                        onPointerDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          remove(v)
                        }}
                      >
                        <X className="size-3" />
                      </span>
                    </Badge>
                  )
                })}
                {overflowCount > 0 && (
                  <Badge variant="secondary" className="font-normal">
                    +{overflowCount}
                  </Badge>
                )}
              </>
            )}
          </span>
          <ChevronDown className="text-muted-foreground size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-[--radix-popover-trigger-width] p-0", contentClassName)}
        align="start"
      >
        <Command
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          {searchable && <CommandInput placeholder={searchPlaceholder} />}
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selected.includes(option.value)
                return (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    disabled={option.disabled}
                    onSelect={() => toggle(option.value)}
                    className="gap-2"
                  >
                    <Checkbox checked={isSelected} className="pointer-events-none" />
                    {option.icon}
                    <span className="flex-1 truncate">{option.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
