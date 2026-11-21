import * as React from "react"
import { format, type Locale } from "date-fns"
import { cn } from "../lib/utils"
import { DatePicker } from "./date-picker"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

const minutesOfDay = (date: Date) => date.getHours() * 60 + date.getMinutes()

const atMinutes = (day: Date, minutes: number) => {
  const next = new Date(day)
  next.setHours(0, minutes, 0, 0)
  return next
}

/** "HH:mm" to minutes after midnight; 0 for anything else. */
function parseTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return 0
  return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2]))
}

interface DateTimePickerProps {
  /** Goes to the date button, so a `<Label htmlFor>` names it. */
  id?: string
  value?: Date
  onChange: (value: Date | undefined) => void
  /** The date button's text while there is no value. */
  placeholder?: string
  /** Accessible name of the time menu. */
  timeLabel?: string
  /** Time of day ("HH:mm") a newly picked day starts at; midnight when left out. */
  defaultTime?: string
  /** Minutes between the times in the menu. */
  stepMinutes?: number
  /** date-fns locale for the date, the calendar and the times; US English when left out. */
  locale?: Locale
  disabled?: boolean
  className?: string
}

/**
 * A date and a time of day: the calendar button of `DatePicker` with a menu
 * of times next to it. The time menu waits for a date. Picking the selected
 * day again clears the value.
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  placeholder,
  timeLabel,
  defaultTime = "00:00",
  stepMinutes = 15,
  locale,
  disabled,
  className,
}: Readonly<DateTimePickerProps>) {
  const current = value && !Number.isNaN(value.getTime()) ? value : undefined
  const selectedMinutes = current ? minutesOfDay(current) : null

  // Every step through the day, plus the current time when it falls between two.
  const options = React.useMemo(() => {
    const step = Math.max(1, Math.floor(stepMinutes))
    const list = Array.from({ length: Math.ceil((24 * 60) / step) }, (_, i) => i * step)
    if (selectedMinutes !== null && !list.includes(selectedMinutes)) {
      list.push(selectedMinutes)
      list.sort((a, b) => a - b)
    }
    return list
  }, [stepMinutes, selectedMinutes])

  const day = current ?? new Date()

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <DatePicker
        id={id}
        date={current}
        placeholder={placeholder}
        locale={locale}
        disabled={disabled}
        className="min-w-0 flex-1"
        onDateChange={(next) =>
          onChange(next ? atMinutes(next, selectedMinutes ?? parseTime(defaultTime)) : undefined)
        }
      />
      <Select
        value={selectedMinutes === null ? "" : String(selectedMinutes)}
        disabled={disabled || !current}
        onValueChange={(minutes) => {
          if (current) onChange(atMinutes(current, Number(minutes)))
        }}
      >
        <SelectTrigger className="w-32 shrink-0 tabular-nums" aria-label={timeLabel}>
          <SelectValue placeholder="–" />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {options.map((minutes) => (
            <SelectItem key={minutes} value={String(minutes)} className="tabular-nums">
              {format(atMinutes(day, minutes), "p", { locale })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
