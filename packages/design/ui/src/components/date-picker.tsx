"use client"

import * as React from "react"
import { format, type Locale } from "date-fns"
import type { Matcher } from "react-day-picker"
import { Calendar as CalendarIcon } from "lucide-react"
import { cn } from "../lib/utils"
import { Button } from "./button"
import { Calendar } from "./calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover"

interface DatePickerProps
  extends Omit<React.ComponentProps<typeof Button>, "children" | "onChange" | "value"> {
  date?: Date
  onDateChange?: (date: Date | undefined) => void
  placeholder?: string
  /** date-fns locale for the trigger label and the calendar; US English when left out. */
  locale?: Locale
  /** Days that can't be picked, e.g. `{ before: tomorrow }` for a date in the future. */
  disabledDays?: Matcher | Matcher[]
  /** The trigger's label for the picked date; date-fns "PPP" ("November 22nd, 2026") when left out. */
  formatDate?: (date: Date) => string
  /**
   * "dropdown" puts month and year menus in the calendar's caption, for dates
   * far from today (a date of birth). Set `startMonth` and `endMonth` with it.
   */
  captionLayout?: React.ComponentProps<typeof Calendar>["captionLayout"]
  startMonth?: Date
  endMonth?: Date
}

/**
 * A date field: an outline button that opens a calendar and closes on a pick.
 * Other props go to the button, so a form control can set its id and aria
 * attributes. Picking the selected day again clears the date.
 */
export function DatePicker({
  date,
  onDateChange,
  placeholder = "Pick a date",
  locale,
  disabledDays,
  formatDate,
  captionLayout,
  startMonth,
  endMonth,
  className,
  ...props
}: Readonly<DatePickerProps>) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={"outline"}
          {...props}
          className={cn(
            "w-full justify-start text-left font-normal",
            !date && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? (formatDate ? formatDate(date) : format(date, "PPP", { locale })) : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date}
          locale={locale}
          disabled={disabledDays}
          captionLayout={captionLayout}
          startMonth={startMonth}
          endMonth={endMonth}
          onSelect={(next) => {
            onDateChange?.(next)
            setOpen(false)
          }}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  )
}
