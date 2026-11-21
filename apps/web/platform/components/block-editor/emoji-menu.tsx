/**
 * The ":" emoji picker (also opened by the slash menu's Emoji command),
 * grouped under category names while browsing.
 *
 * BlockNote's own picker lists every emoji in one run. This one keeps its
 * trigger, 10-column grid and item styling, and adds a heading row where a
 * category starts. Typing a search after ":" shows BlockNote's search results
 * as before, without headings: they are ranked, not grouped.
 */

import { useMemo, type ReactNode } from 'react';
import {
  getDefaultReactEmojiPickerItems,
  useComponentsContext,
  useDictionary,
  type DefaultReactGridSuggestionItem,
  type GridSuggestionMenuProps,
} from '@blocknote/react';
import type { EmojiMartData } from '@emoji-mart/data';
import type { BlockNoteEditorInstance } from './block-editor';
import type { BlockEditorStrings } from './strings';

/** Grid width of the picker, as in BlockNote's default. */
export const EMOJI_COLUMNS = 10;

export type EmojiCategoryId = keyof BlockEditorStrings['emojiCategories'];

export type EmojiMenuItem = DefaultReactGridSuggestionItem & {
  /** Set while browsing (empty query): the category heading this emoji sits under. */
  category?: string;
};

let emojiData: Promise<EmojiMartData> | null = null;

/** The emoji-mart data BlockNote's picker uses, loaded once and on demand. */
function loadEmojiData(): Promise<EmojiMartData> {
  emojiData ??= import('@emoji-mart/data').then((mod) => {
    const data = (mod as { default?: unknown }).default ?? mod;
    return data as EmojiMartData;
  });
  return emojiData;
}

/**
 * Every emoji in emoji-mart's category order, each tagged with its category's
 * translated name, or BlockNote's ranked search results for a query.
 */
export async function getEmojiItems(
  editor: BlockNoteEditorInstance,
  query: string,
  categoryNames: BlockEditorStrings['emojiCategories'],
): Promise<EmojiMenuItem[]> {
  if (query.trim() !== '') return getDefaultReactEmojiPickerItems(editor, query);

  const data = await loadEmojiData();
  return data.categories.flatMap((category) => {
    const name = categoryNames[category.id as EmojiCategoryId] ?? category.id;
    return category.emojis.flatMap((emojiId) => {
      const native = data.emojis[emojiId]?.skins[0]?.native;
      if (!native) return [];
      return [
        {
          id: native,
          icon: <>{native}</>,
          category: name,
          onItemClick: () => editor.insertInlineContent(`${native} `),
        },
      ];
    });
  });
}

/**
 * The grid itself: BlockNote's Root, Item, Loader and EmptyItem (so the
 * look and the keyboard selection stay BlockNote's), with a full-width
 * heading before the first emoji of each category.
 */
export function EmojiMenu({ items, loadingState, selectedIndex, onItemClick, columns }: GridSuggestionMenuProps<EmojiMenuItem>) {
  const Components = useComponentsContext()!;
  const dictionary = useDictionary();

  const cells = useMemo(() => {
    const out: ReactNode[] = [];
    items.forEach((item, index) => {
      if (item.category && item.category !== items[index - 1]?.category) {
        out.push(
          <div key={`category-${item.category}`} className="bn-grid-suggestion-menu-category" role="presentation">
            {item.category}
          </div>,
        );
      }
      out.push(
        <Components.GridSuggestionMenu.Item
          key={item.id}
          className="bn-grid-suggestion-menu-item"
          item={item}
          id={`bn-grid-suggestion-menu-item-${index}`}
          isSelected={index === selectedIndex}
          onClick={() => onItemClick?.(item)}
        />,
      );
    });
    return out;
  }, [Components, items, onItemClick, selectedIndex]);

  return (
    <Components.GridSuggestionMenu.Root id="bn-grid-suggestion-menu" columns={columns} className="bn-grid-suggestion-menu">
      {loadingState === 'loading-initial' || loadingState === 'loading' ? (
        <Components.GridSuggestionMenu.Loader className="bn-grid-suggestion-menu-loader" columns={columns} />
      ) : null}
      {cells}
      {cells.length === 0 && loadingState === 'loaded' ? (
        <Components.GridSuggestionMenu.EmptyItem className="bn-grid-suggestion-menu-empty-item" columns={columns}>
          {dictionary.suggestion_menu.no_items_title}
        </Components.GridSuggestionMenu.EmptyItem>
      ) : null}
    </Components.GridSuggestionMenu.Root>
  );
}
