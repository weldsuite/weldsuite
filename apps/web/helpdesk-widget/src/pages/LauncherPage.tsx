import { useSearchParams } from 'react-router-dom';
import { Launcher } from '@/components/widget/chat/launcher';

export function LauncherPage() {
  const [searchParams] = useSearchParams();

  const parentOrigin = searchParams.get('parentOrigin') || undefined;
  const launcherColor = searchParams.get('launcherColor') || undefined;

  return (
    <Launcher
      parentOrigin={parentOrigin}
      launcherColor={launcherColor}
    />
  );
}
