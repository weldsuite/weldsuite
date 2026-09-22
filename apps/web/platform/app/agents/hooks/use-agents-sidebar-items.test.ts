import { describe, expect, it } from 'vitest';
import { classifyAgentIcon } from './use-agents-sidebar-items';

describe('classifyAgentIcon', () => {
  it('treats a lucide name as an icon, not raw text', () => {
    expect(classifyAgentIcon('Receipt')).toBe('lucide');
    expect(classifyAgentIcon('receipt')).toBe('lucide');
  });

  it('falls back for an unknown name instead of rendering the string', () => {
    expect(classifyAgentIcon('not-a-real-icon')).toBe('fallback');
    expect(classifyAgentIcon('Invoice chaser')).toBe('fallback');
  });

  it('keeps emoji and image urls', () => {
    expect(classifyAgentIcon('🧾')).toBe('emoji');
    expect(classifyAgentIcon('/assets/images/weldagent/icon.svg')).toBe('image');
    expect(classifyAgentIcon('https://example.com/icon.png')).toBe('image');
  });

  it('treats an empty icon as the default', () => {
    expect(classifyAgentIcon(null)).toBe('empty');
    expect(classifyAgentIcon('   ')).toBe('empty');
  });
});
