
import { useTranslations } from '@weldsuite/i18n/client';

interface TranscriptionProgressProps {
  progress: number;
}

export function TranscriptionProgress({ progress }: TranscriptionProgressProps) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <p className="text-sm text-muted-foreground mb-4">
        {t('sweep.weldcrm.transcriptionProgress.transcribingCall')}
      </p>
      <div className="w-48 mb-3">
        <div className="h-1.5 w-full bg-gray-100 dark:bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-200 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {Math.round(progress)}%
      </p>
    </div>
  );
}
