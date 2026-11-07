import * as React from "react"
import { Search } from "lucide-react"

import { cn } from "@weldsuite/ui/lib/utils"
import { Input } from "@weldsuite/ui/components/input"

/**
 * A search bar: a 32px `Input` with a magnifier on the left. Takes every input
 * prop; `className` sizes the wrapper (`w-56`, `w-full`, …), `inputClassName`
 * reaches the field itself.
 */
function SearchInput({
  className,
  inputClassName,
  ...props
}: React.ComponentProps<"input"> & { inputClassName?: string }) {
  return (
    <div data-slot="search-input" className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input className={cn("h-8 pl-8", inputClassName)} {...props} />
    </div>
  )
}

export { SearchInput }
