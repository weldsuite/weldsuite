import { CalendarDays } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="text-center space-y-4">
        <CalendarDays className="h-16 w-16 text-muted-foreground mx-auto" />
        <h1 className="text-2xl font-semibold">Booking Page Not Found</h1>
        <p className="text-muted-foreground max-w-md">
          This booking page doesn&apos;t exist or is no longer active.
        </p>
      </div>
    </main>
  );
}
