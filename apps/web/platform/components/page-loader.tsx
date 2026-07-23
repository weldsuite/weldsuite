import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface PageLoaderProps {
  label?: string;
  className?: string;
  fullScreen?: boolean;
}

export function PageLoader({ label = "Loading...", className, fullScreen = true }: PageLoaderProps) {
  return (
    <div className={cn(
      "w-full flex items-center justify-center",
      fullScreen ? "min-h-screen" : "h-full min-h-[calc(100vh-8rem)] pb-[60px]",
      className,
    )}>
      {/* Invisible for the first beat (loader-appear keyframes in globals.css)
          so loads that resolve near-instantly — warm query cache, preloaded
          data — never flash a spinner before content paints. */}
      <div className="flex items-center gap-3 opacity-0 animate-[loader-appear_200ms_ease-out_250ms_forwards]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
