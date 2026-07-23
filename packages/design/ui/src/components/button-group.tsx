import * as React from "react"
import { cn } from "../lib/utils"

export interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {}

const ButtonGroup = React.forwardRef<HTMLDivElement, ButtonGroupProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn("inline-flex [&>*:first-child>button]:!rounded-r-none [&>*:last-child>button]:!rounded-l-none [&>*:last-child>button]:!border-l [&>*:last-child>button]:!border-l-white [&>button:first-child]:!rounded-r-none [&>button:last-child]:!rounded-l-none [&>button:last-child]:!border-l [&>button:last-child]:!border-l-white [&_button:first-child]:!rounded-r-none [&_button:last-child]:!rounded-l-none [&_button:last-child]:!border-l [&_button:last-child]:!border-l-white [&>*]:relative [&>*]:focus-within:z-10 isolate", className)}
        {...props}
      >
        {children}
      </div>
    )
  }
)
ButtonGroup.displayName = "ButtonGroup"

export { ButtonGroup }
