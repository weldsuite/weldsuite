import { useEffect } from 'react';
import { useRouter } from 'expo-router';

/**
 * Huddles has no backend — redirect back rather than showing a dead placeholder.
 */
export default function HuddlesScreen() {
  const router = useRouter();

  useEffect(() => {
    // Replace so pressing back doesn't loop into huddles again
    router.replace('/(tabs)' as any);
  }, [router]);

  return null;
}
