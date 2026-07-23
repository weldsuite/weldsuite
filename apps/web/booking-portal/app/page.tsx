import { CalendarDays } from 'lucide-react';

export default function Home() {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="text-center space-y-4">
        <CalendarDays className="h-16 w-16 text-muted-foreground mx-auto" />
        <h1 className="text-2xl font-semibold">Booking Portal</h1>
        <p className="text-muted-foreground">
          Use the link provided to you to access a booking page.
        </p>
      </div>
    </main>
  );
}
