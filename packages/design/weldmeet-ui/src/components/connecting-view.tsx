import { Loader2 } from 'lucide-react';

export function ConnectingView() {
  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-[16px] text-muted-foreground">Connecting...</p>
      </div>
    </div>
  );
}
