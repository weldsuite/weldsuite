import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Echo the key so assertions read as the translation path.
vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));

import { TranscriptTabContent } from './transcript-tab';

const baseProps = {
  segments: undefined,
  isLoading: false,
  isTranscribing: false,
  transcriptionProgress: 0,
  hasTranscription: false,
  activeSegmentId: null,
  searchQuery: '',
  onSeekToSegment: () => {},
  segmentRefs: { current: new Map<string, HTMLDivElement>() },
};

describe('TranscriptTabContent empty state', () => {
  it('offers Transcribe when there is no transcription yet', () => {
    render(<TranscriptTabContent {...baseProps} onTranscribe={() => {}} />);

    expect(screen.getByText('sweep.weldcrm.globalFloatingCall.noTranscriptAvailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sweep.weldcrm.meetingIntelligenceHeader.transcribe' })).toBeInTheDocument();
  });

  // TASK-734: a failed transcription used to fall back to the plain empty
  // state, so the user never learned it failed.
  it('shows the failed state with a retry when the last attempt failed', async () => {
    const onTranscribe = vi.fn();
    const user = userEvent.setup();
    render(<TranscriptTabContent {...baseProps} transcriptionFailed onTranscribe={onTranscribe} />);

    expect(screen.getByText('sweep.weldcrm.meetingIntelligence.transcriptionFailed')).toBeInTheDocument();
    expect(screen.getByText('sweep.weldcrm.transcriptTab.transcriptionFailedDescription')).toBeInTheDocument();
    expect(screen.queryByText('sweep.weldcrm.globalFloatingCall.noTranscriptAvailable')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'sweep.weldcrm.transcriptTab.tryAgain' }));
    expect(onTranscribe).toHaveBeenCalledOnce();
  });
});
