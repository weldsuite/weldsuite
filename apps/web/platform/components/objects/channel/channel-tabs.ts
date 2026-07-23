import { Users, MessagesSquare, Paperclip, Bookmark } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

export interface ChannelTab extends ObjectPanelTabDescriptor {
  id: 'people' | 'threads' | 'attachments' | 'bookmarks';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export const CHANNEL_TABS: ChannelTab[] = [
  { id: 'people', label: 'People', icon: Users, required: true, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'threads', label: 'Threads', icon: MessagesSquare, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'attachments', label: 'Attachments', icon: Paperclip, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
  { id: 'bookmarks', label: 'Bookmarks', icon: Bookmark, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
];
