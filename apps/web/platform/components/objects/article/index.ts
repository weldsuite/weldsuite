import { lazy } from 'react';
import { registerObjectPanel } from '@/components/object-panel';

// Lazy-loaded so the panel body only ships when actually opened (object-panel
// host + entity-sheet host both wrap the renderer in <Suspense>).
const ArticlePanel = lazy(() =>
  import('./article-panel').then((m) => ({ default: m.ArticlePanel })),
);

registerObjectPanel({
  type: 'article',
  label: 'Article',
  component: ArticlePanel,
});

export { ArticlePanel };
