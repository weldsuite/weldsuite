import { ArticlePanel } from '@/components/objects/article';
import type { EntitySheetRendererProps } from '../types';

export function ArticleSheet({ entityId, onClose }: Readonly<EntitySheetRendererProps>) {
  return <ArticlePanel id={entityId} isOpen onClose={onClose} />;
}
