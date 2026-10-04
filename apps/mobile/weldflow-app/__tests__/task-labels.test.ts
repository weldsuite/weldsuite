import { labelsForIds, resolveLabelIds } from '@/lib/task-labels';
import type { ProjectLabel } from '@/types/weldflow';

function label(id: string, name: string): ProjectLabel {
  return { id, name, color: '#3b82f6', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}

const LABELS = [label('lbl_bug', 'Bug'), label('lbl_feat', 'Feature'), label('lbl_ux', 'UX')];

describe('resolveLabelIds', () => {
  it('keeps label IDs set on web', () => {
    expect(resolveLabelIds(['lbl_bug', 'lbl_ux'], LABELS)).toEqual(['lbl_bug', 'lbl_ux']);
  });

  it('maps names written by older mobile builds back to IDs', () => {
    expect(resolveLabelIds(['lbl_bug', 'Feature'], LABELS)).toEqual(['lbl_bug', 'lbl_feat']);
  });

  it('drops the duplicate when a label is stored as both ID and name', () => {
    expect(resolveLabelIds(['lbl_bug', 'Bug'], LABELS)).toEqual(['lbl_bug']);
  });

  it('prefers an ID match over a label that is named like that ID', () => {
    const labels = [...LABELS, label('lbl_odd', 'lbl_bug')];
    expect(resolveLabelIds(['lbl_bug'], labels)).toEqual(['lbl_bug']);
  });

  it('keeps entries it cannot resolve', () => {
    expect(resolveLabelIds(['lbl_gone', 'Unknown'], LABELS)).toEqual(['lbl_gone', 'Unknown']);
  });

  it('leaves everything untouched while the label list is still loading', () => {
    expect(resolveLabelIds(['lbl_bug', 'Feature'], [])).toEqual(['lbl_bug', 'Feature']);
  });
});

describe('labelsForIds', () => {
  it('returns the label objects for the selected IDs', () => {
    expect(labelsForIds(['lbl_ux', 'lbl_bug'], LABELS).map((l) => l.name)).toEqual(['Bug', 'UX']);
  });

  it('does not match on name', () => {
    expect(labelsForIds(['Bug'], LABELS)).toEqual([]);
  });
});
