import { Card, CardContent } from '@weldsuite/ui/components/card';
import { VideoOff } from 'lucide-react';

export default function HomePage() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6 text-center">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <VideoOff className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Invalid meeting link</h2>
          <p className="text-sm text-muted-foreground">
            Please check the meeting link you received and try again.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
