/**
 * The AI island at the bottom of the mail composer: the shared `AgentIsland`
 * (the same pill and composer as on the whiteboard) with the mail actions in
 * its button row: prompt ideas (+), tone and length, rewriting what is already
 * written (⋮), then send.
 */
import { useState } from 'react';
import { EllipsisVertical } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { DraftMailAiInput, ImproveTextMailAiInput } from '@weldsuite/app-api-client/schemas/mail-ai';
import { AGENT_INPUT_ICON_BUTTON } from '@/components/weldagent/agent-chat-input';
import { AGENT_ISLAND_TEXT_BUTTON, AgentIsland, AgentIslandIdeas } from '@/components/weldagent/agent-island';
import { useI18n } from '@/lib/i18n/provider';

export type ComposeAiTone = NonNullable<DraftMailAiInput['tone']>;
export type ComposeAiLength = NonNullable<DraftMailAiInput['length']>;
export type ComposeAiRewrite = ImproveTextMailAiInput['action'];

/** Tone and length for a draft; left out, the mail account's AI defaults apply. */
export interface ComposeAiOptions {
  tone?: ComposeAiTone;
  length?: ComposeAiLength;
}

const TONES: ComposeAiTone[] = ['professional', 'friendly', 'casual'];
const LENGTHS: ComposeAiLength[] = ['short', 'medium', 'long'];
const REWRITES: ComposeAiRewrite[] = ['improve', 'shorten', 'expand', 'formalize', 'make_friendly'];

export function ComposeAiIsland({
  isReply,
  busy,
  hasTextToRewrite,
  onGenerate,
  onRewrite,
  testIdPrefix,
}: Readonly<{
  /** Replies get reply ideas and placeholder. */
  isReply: boolean;
  /** A draft or rewrite is running. */
  busy: boolean;
  /** Whether the body holds text of the user's own (asked when the ⋮ menu opens). */
  hasTextToRewrite: () => boolean;
  /** Writes the email from the prompt; resolves to whether it did. */
  onGenerate: (prompt: string, options: ComposeAiOptions) => Promise<boolean>;
  /** Rewrites the body in place. */
  onRewrite: (action: ComposeAiRewrite) => Promise<boolean>;
  testIdPrefix: string;
}>) {
  const { t } = useI18n();
  const labels = t.mail.composeAi;
  const [tone, setTone] = useState<ComposeAiTone | 'auto'>('auto');
  const [length, setLength] = useState<ComposeAiLength | 'auto'>('auto');
  const [canRewrite, setCanRewrite] = useState(false);

  const ideas = isReply
    ? [labels.ideas.accept, labels.ideas.decline, labels.ideas.moreDetails, labels.ideas.thankThem]
    : [labels.ideas.meeting, labels.ideas.followUp, labels.ideas.introduce, labels.ideas.thanks];

  // The tone/length button names what is picked.
  const optionsSummary =
    [tone === 'auto' ? null : labels.tones[tone], length === 'auto' ? null : labels.lengths[length]]
      .filter(Boolean)
      .join(' · ') || labels.automatic;

  return (
    <AgentIsland
      label={labels.open}
      placeholder={isReply ? labels.replyPlaceholder : labels.placeholder}
      busy={busy}
      testIdPrefix={testIdPrefix}
      onSubmit={(prompt) =>
        onGenerate(prompt, {
          tone: tone === 'auto' ? undefined : tone,
          length: length === 'auto' ? undefined : length,
        })
      }
      startActions={(controls) => (
        <>
          <AgentIslandIdeas controls={controls} label={labels.ideasLabel} ideas={ideas} disabled={busy} />
          <DropdownMenu {...controls.menu('options')}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                aria-label={labels.optionsLabel}
                title={labels.optionsLabel}
                className={AGENT_ISLAND_TEXT_BUTTON}
              >
                {optionsSummary}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56" onCloseAutoFocus={controls.backToPrompt}>
              <DropdownMenuLabel>{labels.tone}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={tone} onValueChange={(value) => setTone(value as ComposeAiTone | 'auto')}>
                <DropdownMenuRadioItem value="auto">{labels.automatic}</DropdownMenuRadioItem>
                {TONES.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {labels.tones[value]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{labels.length}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={length} onValueChange={(value) => setLength(value as ComposeAiLength | 'auto')}>
                <DropdownMenuRadioItem value="auto">{labels.automatic}</DropdownMenuRadioItem>
                {LENGTHS.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {labels.lengths[value]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      endActions={(controls) => (
        <DropdownMenu {...controls.menu('rewrite', () => setCanRewrite(hasTextToRewrite()))}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={labels.rewriteLabel}
              title={labels.rewriteLabel}
              className={AGENT_INPUT_ICON_BUTTON}
            >
              <EllipsisVertical className="h-[18px] w-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-56" onCloseAutoFocus={controls.backToPrompt}>
            <DropdownMenuLabel>{canRewrite ? labels.rewriteLabel : labels.nothingToRewrite}</DropdownMenuLabel>
            {REWRITES.map((action) => (
              <DropdownMenuItem key={action} disabled={!canRewrite} onSelect={() => void onRewrite(action)}>
                {labels.rewrites[action]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    />
  );
}
