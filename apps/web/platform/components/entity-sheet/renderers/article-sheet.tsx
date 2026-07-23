import { ArticlePanel } from '@/components/objects/article';
import type { EntitySheetRendererProps } from '../types';

export function ArticleSheet({ entityId, onClose }: EntitySheetRendererProps) {
  return <ArticlePanel id={entityId} isOpen onClose={onClose} />;
}
