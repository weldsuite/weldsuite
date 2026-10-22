import { enrollPayload, mapEnrollment, mapSequence, sequencesApi } from '@/services/sequences';
import { appApiClient } from '@/services/app-api';

jest.mock('@/services/app-api', () => ({
  appApiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const client = appApiClient as unknown as {
  get: jest.Mock;
  post: jest.Mock;
  patch: jest.Mock;
  delete: jest.Mock;
};

const sequenceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'wf_1',
  name: 'Welcome series',
  description: null,
  status: 'draft',
  steps: [{}, {}, {}],
  lastExecutedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  enrolledCount: 4,
  activeEnrolledCount: 1,
  pendingEnrolledCount: 3,
  ...overrides,
  ...overrides,
});

const enrollmentRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'senr_1',
  sequenceId: 'wf_1',
  customerId: 'per_1',
  status: 'active',
  currentStepIndex: 1,
  totalSteps: 3,
  enrolledAt: '2026-01-02T00:00:00Z',
  customerEmail: 'jane@acme.test',
  customerFirstName: 'Jane',
  customerLastName: 'Doe',
  customerFullName: null,
  customerCompanyName: 'Acme',
  ...overrides,
  ...overrides,
});

describe('mapSequence', () => {
  it('counts the steps and carries the enrollment counts', () => {
    expect(mapSequence(sequenceRow())).toEqual({
      id: 'wf_1',
      name: 'Welcome series',
      description: undefined,
      status: 'draft',
      stepCount: 3,
      enrolledCount: 4,
      activeCount: 1,
      pendingCount: 3,
      completedCount: undefined,
      failedCount: undefined,
      lastRunAt: undefined,
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  it('reads the detail counts and last run, and copes with missing steps and counts', () => {
    const detail = mapSequence(
      sequenceRow({ completedEnrolledCount: 2, failedEnrolledCount: 0, lastExecutedAt: '2026-02-01T10:00:00Z' }),
    );
    expect(detail.completedCount).toBe(2);
    expect(detail.failedCount).toBe(0);
    expect(detail.lastRunAt).toBe('2026-02-01T10:00:00Z');

    const bare = mapSequence(sequenceRow({ steps: undefined, enrolledCount: undefined, activeEnrolledCount: null }));
    expect(bare.stepCount).toBe(0);
    expect(bare.enrolledCount).toBe(0);
    expect(bare.activeCount).toBe(0);
  });
});

describe('mapEnrollment', () => {
  it('names the person from the snapshot columns and keeps the person id', () => {
    expect(mapEnrollment(enrollmentRow())).toMatchObject({
      id: 'senr_1',
      personId: 'per_1',
      name: 'Jane Doe',
      email: 'jane@acme.test',
      companyName: 'Acme',
      status: 'active',
      currentStepIndex: 1,
      totalSteps: 3,
    });
  });

  it('prefers the full name and falls back to the email', () => {
    expect(mapEnrollment(enrollmentRow({ customerFullName: 'Dr. Jane Doe' })).name).toBe('Dr. Jane Doe');
    expect(
      mapEnrollment(enrollmentRow({ customerFirstName: null, customerLastName: null, customerFullName: null })).name,
    ).toBe('jane@acme.test');
  });

  it('keeps an error message for a failed enrollment', () => {
    expect(mapEnrollment(enrollmentRow({ status: 'failed', errorMessage: 'Mailbox full' })).errorMessage).toBe(
      'Mailbox full',
    );
    expect(mapEnrollment(enrollmentRow({ errorMessage: '  ' })).errorMessage).toBeUndefined();
  });
});

describe('enrollPayload', () => {
  it('sends person ids once each', () => {
    expect(enrollPayload(['a', 'b', 'a'])).toEqual({ personIds: ['a', 'b'] });
  });
});

describe('sequencesApi', () => {
  it('lists sequences as a page', async () => {
    client.get.mockResolvedValue({
      data: [sequenceRow()],
      pagination: { totalCount: 1, hasMore: false, cursor: null },
    });
    const res = await sequencesApi.getSequences({ search: ' welcome ' });
    expect(client.get).toHaveBeenCalledWith('/sequences?limit=25&search=welcome');
    expect(res.data).toMatchObject({ totalCount: 1, hasMore: false, cursor: null });
    expect(res.data?.items[0]?.name).toBe('Welcome series');
  });

  it('reads one sequence', async () => {
    client.get.mockResolvedValue({ data: sequenceRow({ status: 'active' }) });
    const res = await sequencesApi.getSequence('wf_1');
    expect(client.get).toHaveBeenCalledWith('/sequences/wf_1');
    expect(res.data?.status).toBe('active');
  });

  it('lists enrollments with a status filter and cursor', async () => {
    client.get.mockResolvedValue({
      data: [enrollmentRow()],
      pagination: { totalCount: 40, hasMore: true, cursor: 'senr_1' },
    });
    const res = await sequencesApi.getEnrollments('wf_1', { status: 'paused', cursor: 'senr_0', search: 'jane' });
    expect(client.get).toHaveBeenCalledWith(
      '/sequences/wf_1/enrollments?limit=25&cursor=senr_0&search=jane&status=paused',
    );
    expect(res.data).toMatchObject({ totalCount: 40, hasMore: true, cursor: 'senr_1' });
  });

  it('launches, pauses and resumes a sequence', async () => {
    client.post.mockResolvedValue({ data: {} });
    expect((await sequencesApi.launch('wf_1')).success).toBe(true);
    expect((await sequencesApi.pause('wf_1')).success).toBe(true);
    expect((await sequencesApi.resume('wf_1')).success).toBe(true);
    expect(client.post.mock.calls.map((call) => call[0])).toEqual([
      '/sequences/wf_1/launch',
      '/sequences/wf_1/pause',
      '/sequences/wf_1/resume',
    ]);
  });

  it('enrolls a person and reports when they were already enrolled', async () => {
    client.post.mockResolvedValue({ data: { enrolled: 0, enrollmentIds: [] } });
    const res = await sequencesApi.enrollPerson('wf_1', 'per_1');
    expect(client.post).toHaveBeenCalledWith('/sequences/wf_1/enroll', { personIds: ['per_1'] });
    expect(res.data).toEqual({ enrolled: 0 });
  });

  it('pauses, resumes and unenrolls an enrollment', async () => {
    client.patch.mockResolvedValue({ data: {} });
    client.delete.mockResolvedValue({});
    await sequencesApi.pauseEnrollment('wf_1', 'senr_1');
    await sequencesApi.resumeEnrollment('wf_1', 'senr_1');
    await sequencesApi.unenroll('senr_1');
    expect(client.patch).toHaveBeenNthCalledWith(1, '/sequences/wf_1/enrollments/senr_1/pause', {});
    expect(client.patch).toHaveBeenNthCalledWith(2, '/sequences/wf_1/enrollments/senr_1/resume', {});
    expect(client.delete).toHaveBeenCalledWith('/sequences/enrollments/senr_1');
  });

  it('hands the server message back when a launch is refused', async () => {
    client.post.mockRejectedValue(new Error('Add at least one step before launching this sequence'));
    expect(await sequencesApi.launch('wf_1')).toEqual({
      success: false,
      error: 'Add at least one step before launching this sequence',
    });
  });
});
