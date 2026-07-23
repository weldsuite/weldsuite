"use client"

import * as React from "react"
import { Check, ChevronsUpDown, X, Loader2 } from "lucide-react"

import { cn } from "../lib/utils"
import { Button } from "./button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover"

export interface AutocompleteOption {
  value: string
  label: string
  icon?: React.ReactNode
  description?: string
  disabled?: boolean
}

export interface AutocompleteProps {
  options?: AutocompleteOption[]
  value?: string
  onValueChange?: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
  disabled?: boolean
  clearable?: boolean
  loading?: boolean
  renderOption?: (option: AutocompleteOption) => React.ReactNode
  filterOption?: (option: AutocompleteOption, search: string) => boolean
  onSearch?: (query: string) => Promise<AutocompleteOption[]>
  debounceMs?: number
  minSearchLength?: number
}

export function Autocomplete({
  options = [],
  value,
  onValueChange,
  placeholder = "Select an option...",
  searchPlaceholder = "Search...",
  emptyText = "No results found.",
  className,
  disabled = false,
  clearable = true,
  loading = false,
  renderOption,
  filterOption,
  onSearch,
  debounceMs = 300,
  minSearchLength = 2,
}: AutocompleteProps) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [fetchedOptions, setFetchedOptions] = React.useState<AutocompleteOption[]>([])
  const [isFetching, setIsFetching] = React.useState(false)
  const debounceTimerRef = React.useRef<NodeJS.Timeout | null>(null)

  // Determine which options to use
  // If using onSearch and search meets minSearchLength, use fetched options
  // Otherwise, use static options (initial data)
  const activeOptions = React.useMemo(() => {
    if (onSearch && search.length >= minSearchLength) {
      return fetchedOptions
    }
    return options
  }, [onSearch, search, minSearchLength, fetchedOptions, options])

  const selectedOption = React.useMemo(
    () => {
      // Check both activeOptions and static options for the selected value
      return activeOptions.find((option) => option.value === value) ||
             options.find((option) => option.value === value)
    },
    [activeOptions, options, value]
  )

  // Fetch options when search changes (only if onSearch is provided)
  React.useEffect(() => {
    if (!onSearch || !open) return

    // Clear previous timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    // If search is empty or below minimum length, clear fetched options
    if (!search || search.length < minSearchLength) {
      setFetchedOptions([])
      setIsFetching(false)
      return
    }

    // Set loading state
    setIsFetching(true)

    // Debounce the search
    debounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await onSearch(search)
        setFetchedOptions(results)
      } catch (error) {
        console.error("Error fetching autocomplete options:", error)
        setFetchedOptions([])
      } finally {
        setIsFetching(false)
      }
    }, debounceMs)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [search, onSearch, open, debounceMs, minSearchLength])

  // Filter options
  const filteredOptions = React.useMemo(() => {
    // If using onSearch and search meets minSearchLength, return fetched options as-is
    if (onSearch && search.length >= minSearchLength) {
      return fetchedOptions
    }

    // Otherwise, show static options (with optional local filtering)
    if (!search) return options

    // Apply custom filter if provided
    if (filterOption) {
      return options.filter((option) => filterOption(option, search))
    }

    // Default local filtering
    const searchLower = search.toLowerCase()
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(searchLower) ||
        option.value.toLowerCase().includes(searchLower) ||
        option.description?.toLowerCase().includes(searchLower)
    )
  }, [options, fetchedOptions, search, filterOption, onSearch, minSearchLength])

  const handleSelect = React.useCallback(
    (selectedValue: string) => {
      const isSameValue = selectedValue === value
      onValueChange?.(isSameValue ? "" : selectedValue)
      setOpen(false)
    },
    [value, onValueChange]
  )

  const handleClear = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onValueChange?.("")
    },
    [onValueChange]
  )

  const defaultRenderOption = React.useCallback(
    (option: AutocompleteOption) => (
      <>
        {option.icon && <span className="mr-2">{option.icon}</span>}
        <div className="flex flex-col gap-0.5">
          <span>{option.label}</span>
          {option.description && (
            <span className="text-xs text-muted-foreground">
              {option.description}
            </span>
          )}
        </div>
      </>
    ),
    []
  )

  // Determine the empty message based on state
  const getEmptyMessage = () => {
    if (isFetching) {
      return "Searching..."
    }
    if (onSearch && search.length > 0 && search.length < minSearchLength) {
      return `Type at least ${minSearchLength} characters to search`
    }
    return emptyText
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full justify-between shadow-none",
            !selectedOption && "text-muted-foreground",
            className
          )}
          disabled={disabled || loading}
        >
          <span className="truncate">
            {loading
              ? "Loading..."
              : selectedOption
                ? selectedOption.label
                : placeholder}
          </span>
          <div className="ml-2 flex items-center gap-1">
            {clearable && selectedOption && !disabled && (
              <X
                className="h-4 w-4 shrink-0 opacity-50 hover:opacity-100"
                onClick={handleClear}
              />
            )}
            {isFetching ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin opacity-50" />
            ) : (
              <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
            )}
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        align="start"
        sideOffset={4}
        style={{ width: 'var(--radix-popover-trigger-width)' }}
      >
        <Command shouldFilter={false} className="w-full">
          <CommandInput
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{getEmptyMessage()}</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={handleSelect}
                  disabled={option.disabled}
                  className={cn(
                    "cursor-pointer",
                    option.disabled && "cursor-not-allowed"
                  )}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 flex-shrink-0",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    {renderOption ? renderOption(option) : defaultRenderOption(option)}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
