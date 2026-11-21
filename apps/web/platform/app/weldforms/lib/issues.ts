/**
 * Definition issues from the engine, mapped to the block they belong to so the
 * outline can mark it.
 */

import type { DefinitionIssue, FormDefinition } from '@weldsuite/forms-engine';

/** The id of the block an issue is about, from its `blockId` or its JSON path; null for form-level issues. */
export function blockIdForIssue(def: FormDefinition, issue: DefinitionIssue): string | null {
  if (issue.blockId) return issue.blockId;
  const parts = issue.path.split('.');
  const index = Number(parts[1]);
  if (parts[0] === 'blocks' && Number.isInteger(index)) {
    const block = def.blocks[index];
    if (!block) return null;
    if (parts[2] === 'children') {
      const child = block.type === 'group' ? block.children[Number(parts[3])] : undefined;
      return child?.id ?? block.id;
    }
    return block.id;
  }
  if (parts[0] === 'logic' && Number.isInteger(index)) return def.logic[index]?.blockId ?? null;
  return null;
}

export function issuesByBlock(def: FormDefinition, issues: readonly DefinitionIssue[]): Map<string, DefinitionIssue[]> {
  const map = new Map<string, DefinitionIssue[]>();
  for (const issue of issues) {
    const id = blockIdForIssue(def, issue);
    if (!id) continue;
    const list = map.get(id);
    if (list) list.push(issue);
    else map.set(id, [issue]);
  }
  return map;
}

/** Issues of a block and, for a group, of its children. */
export function issuesForBlockTree(def: FormDefinition, byBlock: Map<string, DefinitionIssue[]>, blockId: string): DefinitionIssue[] {
  const block = def.blocks.find((b) => b.id === blockId);
  const own = byBlock.get(blockId) ?? [];
  if (block?.type !== 'group') return own;
  return [...own, ...block.children.flatMap((c) => byBlock.get(c.id) ?? [])];
}
