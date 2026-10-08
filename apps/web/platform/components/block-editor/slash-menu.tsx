import type { ReactElement } from 'react';
import {
  getDefaultSlashMenuItems,
  insertOrUpdateBlockForSlashMenu,
  SuggestionMenu,
} from '@blocknote/core/extensions';
import type { DefaultReactSuggestionItem } from '@blocknote/react';
import {
  AppWindow,
  AudioLines,
  Bookmark,
  CalendarDays,
  Codepen,
  Figma,
  File as FileIcon,
  FilePlus,
  FileSymlink,
  Film,
  HardDrive,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Lightbulb,
  List,
  ListChecks,
  ListCollapse,
  ListOrdered,
  ListTree,
  MapPin,
  Minus,
  Pilcrow,
  Presentation,
  Quote,
  Smile,
  SquareCode,
  Table as TableIcon,
  Video,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import type { EmbedProvider } from './blocks/embed-url';
import type { SchemaEditor, SchemaPartialBlock } from './schema';
import type { BlockEditorStrings as Strings } from './strings';

/** A page the editor can link to, supplied by the host (WeldKnow). */
export interface PageLink {
  id: string;
  title: string;
  icon?: string | null;
  href: string;
}

/**
 * Host hooks for the page commands. Without them (CRM notes) "Page" and
 * "Link to page" are left out of the menu.
 */
export interface PageLinkSource {
  /** Create a sub-page of the current page; null when it could not be created. */
  create: () => Promise<PageLink | null>;
  /** Pages matching what the user typed after `@`. */
  search: (query: string) => PageLink[];
}

export interface SlashMenuOptions {
  strings: Strings;
  /** BCP 47 tag used to format the date the "Date" command inserts. */
  locale: string;
  pageLinks?: PageLinkSource;
}

/** The character that opens the page-link menu. */
export const PAGE_LINK_TRIGGER = '@';

type GroupKey = keyof Strings['slashMenu']['groups'];
type MenuItem = DefaultReactSuggestionItem & { key: string };

// `size-4`, not `h-4 w-4`: BlockNote's stylesheet reverts the width and height
// of any svg inside the editor that has no `size-*` class, which would leave
// these at Lucide's 24px.
function icon(Icon: LucideIcon): ReactElement {
  return <Icon className="size-4" />;
}

/** BlockNote's built-in commands we keep, with a Lucide icon and Notion-style search terms. */
const BUILT_IN: Record<string, { icon: LucideIcon; aliases?: string[] }> = {
  paragraph: { icon: Pilcrow, aliases: ['text', 'plain'] },
  heading: { icon: Heading1, aliases: ['#', 'title'] },
  heading_2: { icon: Heading2, aliases: ['##', 'subtitle'] },
  heading_3: { icon: Heading3, aliases: ['###'] },
  check_list: { icon: ListChecks, aliases: ['todo', 'to-do', 'task', '[]'] },
  bullet_list: { icon: List, aliases: ['bulleted', 'unordered', '-'] },
  numbered_list: { icon: ListOrdered, aliases: ['ordered', '1.'] },
  toggle_list: { icon: ListCollapse, aliases: ['collapse', 'dropdown', '>'] },
  quote: { icon: Quote, aliases: ['citation', 'blockquote'] },
  divider: { icon: Minus, aliases: ['line', 'separator', 'hr', '---'] },
  table: { icon: TableIcon, aliases: ['grid'] },
  image: { icon: ImageIcon, aliases: ['picture', 'photo'] },
  video: { icon: Video, aliases: ['movie', 'mp4'] },
  audio: { icon: AudioLines, aliases: ['sound', 'music', 'mp3'] },
  file: { icon: FileIcon, aliases: ['attachment', 'upload', 'pdf'] },
  code_block: { icon: SquareCode, aliases: ['code', 'snippet', '```'] },
  toggle_heading: { icon: Heading1 },
  toggle_heading_2: { icon: Heading2 },
  toggle_heading_3: { icon: Heading3 },
  emoji: { icon: Smile, aliases: ['emoticon', ':'] },
};

/** Menu order, Notion's: each group lists built-in keys and our own. */
const LAYOUT: { group: GroupKey; keys: string[] }[] = [
  {
    group: 'basic',
    keys: [
      'paragraph', 'page', 'check_list', 'heading', 'heading_2', 'heading_3', 'table', 'bullet_list',
      'numbered_list', 'toggle_list', 'quote', 'divider', 'linkToPage', 'callout',
    ],
  },
  { group: 'media', keys: ['image', 'video', 'audio', 'code_block', 'file', 'bookmark'] },
  {
    group: 'embeds',
    keys: ['embed', 'youtube', 'vimeo', 'loom', 'figma', 'googleDrive', 'googleMaps', 'codepen', 'miro'],
  },
  { group: 'advanced', keys: ['tableOfContents', 'toggle_heading', 'toggle_heading_2', 'toggle_heading_3'] },
  { group: 'inline', keys: ['date', 'emoji'] },
];

const EMBED_ITEMS: { key: keyof Strings['slashMenu']['items'] & string; provider: EmbedProvider; icon: LucideIcon; aliases?: string[] }[] = [
  { key: 'embed', provider: 'generic', icon: AppWindow, aliases: ['iframe', 'website', 'url'] },
  { key: 'youtube', provider: 'youtube', icon: Youtube, aliases: ['video'] },
  { key: 'vimeo', provider: 'vimeo', icon: Film, aliases: ['video'] },
  { key: 'loom', provider: 'loom', icon: Video, aliases: ['recording', 'screen'] },
  { key: 'figma', provider: 'figma', icon: Figma, aliases: ['design', 'prototype'] },
  { key: 'googleDrive', provider: 'googleDrive', icon: HardDrive, aliases: ['docs', 'sheets', 'slides', 'gdrive'] },
  { key: 'googleMaps', provider: 'googleMaps', icon: MapPin, aliases: ['map', 'location', 'address'] },
  { key: 'codepen', provider: 'codepen', icon: Codepen, aliases: ['code', 'demo'] },
  { key: 'miro', provider: 'miro', icon: Presentation, aliases: ['whiteboard', 'board'] },
];

function customItems(editor: SchemaEditor, { strings, locale, pageLinks }: SlashMenuOptions): Map<string, MenuItem> {
  const t = strings.slashMenu.items;
  const items = new Map<string, MenuItem>();
  const add = (key: string, item: Omit<MenuItem, 'key'>) => items.set(key, { key, ...item });
  const insert = (block: SchemaPartialBlock) => () => {
    insertOrUpdateBlockForSlashMenu(editor, block);
  };

  if (pageLinks) {
    add('page', {
      ...t.page,
      icon: icon(FilePlus),
      aliases: ['subpage', 'new page', 'document'],
      onItemClick: () => {
        void pageLinks.create().then((page) => {
          if (!page) return;
          insertOrUpdateBlockForSlashMenu(editor, {
            type: 'paragraph',
            content: [{ type: 'link', href: page.href, content: page.title }],
          });
        });
      },
    });
    add('linkToPage', {
      ...t.linkToPage,
      icon: icon(FileSymlink),
      aliases: ['mention', 'reference', PAGE_LINK_TRIGGER],
      onItemClick: () => {
        editor.getExtension(SuggestionMenu)?.openSuggestionMenu(PAGE_LINK_TRIGGER, {
          deleteTriggerCharacter: true,
          ignoreQueryLength: true,
        });
      },
    });
  }

  add('callout', {
    ...t.callout,
    icon: icon(Lightbulb),
    aliases: ['note', 'info', 'warning', 'alert', 'tip'],
    onItemClick: insert({ type: 'callout' }),
  });
  add('bookmark', {
    ...t.bookmark,
    icon: icon(Bookmark),
    aliases: ['link', 'url', 'card'],
    onItemClick: insert({ type: 'bookmark' }),
  });
  for (const embed of EMBED_ITEMS) {
    add(embed.key, {
      ...t[embed.key],
      icon: icon(embed.icon),
      aliases: embed.aliases,
      onItemClick: insert({ type: 'embed', props: { provider: embed.provider } }),
    });
  }
  add('tableOfContents', {
    ...t.tableOfContents,
    icon: icon(ListTree),
    aliases: ['toc', 'outline', 'contents'],
    onItemClick: insert({ type: 'tableOfContents' }),
  });
  add('date', {
    ...t.date,
    icon: icon(CalendarDays),
    aliases: ['today', 'now', 'day'],
    onItemClick: () => {
      const today = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date());
      editor.insertInlineContent(`${today} `);
    },
  });

  return items;
}

/**
 * Every `/` command, in menu order. The menu only inserts things; formatting
 * (block type, colors, alignment, …) lives in the document toolbar. BlockNote's built-in commands keep their
 * (localized) names; ours come from the `blockEditor` translations. Items
 * carry a stable `key` so callers and tests don't have to match on titles.
 */
export function getSlashMenuItems(editor: SchemaEditor, options: SlashMenuOptions): MenuItem[] {
  const { strings } = options;
  const builtIn = new Map<string, MenuItem>();
  for (const item of getDefaultSlashMenuItems(editor)) {
    const extra = BUILT_IN[item.key];
    if (!extra) continue;
    const { key, ...rest } = item;
    builtIn.set(key, {
      ...rest,
      key,
      icon: icon(extra.icon),
      // BlockNote lists "embed" as an alias of its media blocks, which would
      // put Image/Video/Audio/File ahead of the Embed command for "/embed".
      aliases: [...(rest.aliases ?? []).filter((alias) => alias !== 'embed'), ...(extra.aliases ?? [])],
    });
  }
  const custom = customItems(editor, options);

  const items: MenuItem[] = [];
  for (const { group, keys } of LAYOUT) {
    for (const key of keys) {
      const item = builtIn.get(key) ?? custom.get(key);
      if (item) items.push({ ...item, group: strings.slashMenu.groups[group] });
    }
  }
  return items;
}

/** Whether `query` starts a word of `text` ("red" matches "Red background", not "Numbered"). */
function matchesAtWordStart(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  let index = haystack.indexOf(query);
  while (index !== -1) {
    if (index === 0 || !/[\p{L}\p{N}]/u.test(haystack[index - 1]!)) return true;
    index = haystack.indexOf(query, index + 1);
  }
  return false;
}

/**
 * The commands matching what was typed after `/`, in menu order. BlockNote's
 * own filter matches anywhere inside a title or alias, so "/red" offered
 * "Numbered List" (and "unordered") ahead of the color; matching only at the
 * start of a word keeps short queries on target.
 */
export function filterSlashMenuItems<T extends { title: string; aliases?: readonly string[] }>(
  items: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) =>
      matchesAtWordStart(item.title, needle) ||
      (item.aliases ?? []).some((alias) => matchesAtWordStart(alias, needle)),
  );
}

/** Items for the `@` menu: one per matching page, inserting a link to it. */
export function getPageLinkItems(
  editor: SchemaEditor,
  pages: PageLink[],
  untitled: string,
): DefaultReactSuggestionItem[] {
  return pages.map((page) => {
    const title = page.title || untitled;
    return {
      title,
      icon: page.icon ? <span className="text-sm leading-none">{page.icon}</span> : icon(FileIcon),
      onItemClick: () => {
        editor.insertInlineContent([{ type: 'link', href: page.href, content: title }, ' ']);
      },
    };
  });
}
