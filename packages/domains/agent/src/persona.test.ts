import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateText, streamText, stepCountIs } from '@weldsuite/ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  PERSONA_FALLBACK_TEXT,
  PERSONA_MAX_STEPS,
  PERSONA_SHEET_MAX_STEPS,
  PERSONA_TOOL_IDS,
  buildPersonaCall,
  buildPersonaSystem,
  buildPersonaToolSet,
  createPersonaTextTransform,
  holdsPermissions,
  personaPermissionKeys,
  personaReplyText,
  personaRowScope,
  personaSheetIds,
  selectPersonaSheetTools,
  selectPersonaTools,
  sumStepUsage,
  type PersonaSheets,
} from './persona';
import { sheetToolsLimitedTo } from './sheets-tools';
import { PLATFORM_TOOLS, type PlatformToolDefinition, type ToolContext } from './tools';

const ids = (permissions: string[]) => selectPersonaTools(holdsPermissions(permissions)).map((t) => t.id);

describe('which tools the default WeldAgent gets', () => {
  const READ_ALL = ['people:read', 'tickets:read', 'tasks:read', 'projects:read'];

  it('offers every read tool to someone who may read it all', () => {
    expect(ids(READ_ALL).sort()).toEqual([...PERSONA_TOOL_IDS].sort());
    expect(ids(['*']).sort()).toEqual([...PERSONA_TOOL_IDS].sort());
  });

  it('gives only what the user\'s own permissions cover', () => {
    expect(ids(['tasks:read'])).toEqual(['tasks.list']);
    expect(ids(['people:read', 'projects:read']).sort()).toEqual(['people.get', 'people.list', 'projects.get', 'projects.list']);
    expect(ids([])).toEqual([]);
    // Creating or changing needs a permission too, but is not something this persona does.
    expect(ids(['tasks:create', 'people:create', 'tickets:create'])).toEqual([]);
  });

  it('counts a per-app grant like the agent tools do (weldcrm:people:read opens people)', () => {
    expect(ids(['weldcrm:people:read'])).toEqual(['people.list', 'people.get']);
  });

  it('never offers a tool that changes anything, computer use, browsing or sheets', () => {
    const everything = selectPersonaTools(() => true);
    for (const tool of everything) {
      expect(tool.name).toMatch(/^(list|get)_/);
    }
    const names = everything.map((t) => t.name);
    for (const forbidden of ['create_task', 'create_person', 'create_ticket', 'save_agent_setup', 'message_agent', 'browser_open']) {
      expect(names).not.toContain(forbidden);
    }
    expect(PERSONA_TOOL_IDS.every((id) => PLATFORM_TOOLS.some((t) => t.id === id))).toBe(true);
  });

  it('consults the row-level grants as well as the tools\' own permissions', () => {
    expect(personaPermissionKeys()).toEqual(
      expect.arrayContaining(['people:read', 'tickets:read', 'tasks:read', 'projects:read', 'people:scope:all', 'projects:scope:all']),
    );
    expect(personaRowScope('u1', holdsPermissions(['people:scope:all']))).toEqual({
      userId: 'u1',
      allPeople: true,
      allProjects: false,
    });
    expect(personaRowScope('u1', holdsPermissions(['*']))).toEqual({ userId: 'u1', allPeople: true, allProjects: true });
    expect(personaRowScope('u1', holdsPermissions([]))).toEqual({ userId: 'u1', allPeople: false, allProjects: false });
  });
});

describe('the instructions', () => {
  const system = (permissions: string[], extra?: string) =>
    buildPersonaSystem({
      tools: selectPersonaTools(holdsPermissions(permissions)),
      extraSystem: extra,
      today: '2026-10-27',
      timezone: 'Europe/Amsterdam',
    });

  it('tells it to use tools for workspace questions and never to state what no tool returned', () => {
    const text = system(['tasks:read', 'projects:read', 'people:read']);
    expect(text).toContain('call your tools first');
    expect(text).toContain('Only state counts, names, records, dates, notifications or emails that a tool returned');
    expect(text).toContain('Never guess, estimate or invent');
  });

  it('says plainly what it cannot see and where to go instead, never to promise a later check', () => {
    const text = system(['tasks:read']);
    expect(text).toContain('notifications, the mail inbox, the calendar');
    expect(text).toContain('open that app, or pick a workspace agent from the agent menu');
    expect(text).toContain('Never promise to check later');
  });

  it('keeps ids, tool names and field keys away from the user', () => {
    expect(system(['tasks:read'])).toContain('Never show internal ids');
    expect(system(['tasks:read'])).toContain('tool names');
  });

  it('describes only the lookups this user has, with today\'s date for "today"', () => {
    const text = system(['tasks:read', 'projects:read']);
    expect(text).toContain('list_tasks');
    expect(text).toContain('list_projects');
    expect(text).not.toContain('list_people');
    expect(text).not.toContain('list_tickets');
    expect(text).toContain('Today is 2026-10-27 (Europe/Amsterdam)');
    // The three starter questions have a path to a true answer.
    expect(text).toContain('What is on my plate today');
    expect(text).toContain('assignedToMe=true, includeDone=false and dueOnOrBefore set to today');
    expect(text).toContain('My open tasks');
    expect(system(['people:read'])).toContain('list_people');
  });

  it('says it can read nothing when the user has no read permission', () => {
    const text = system([]);
    expect(text).toContain('you have no lookup tools for this user');
    expect(text).not.toContain('Today is');
  });

  it('appends the extra context the client sent', () => {
    expect(system(['tasks:read'], 'The user is viewing the task "Quarterly report".')).toMatch(
      /Quarterly report"\.$/,
    );
  });
});

describe('buildPersonaCall', () => {
  const base = {
    db: {} as never,
    workspaceId: 'org_1',
    userId: 'user_1',
    timezone: 'Europe/Amsterdam',
    now: new Date('2026-10-27T10:00:00Z'),
  };

  it('offers tools, instructions and a step limit for a user who may read', async () => {
    const call = await buildPersonaCall({ ...base, holds: holdsPermissions(['tasks:read', 'projects:read']) });
    expect(call.toolNames.sort()).toEqual(['get_project', 'list_projects', 'list_tasks']);
    expect(Object.keys(call.tools ?? {}).sort()).toEqual(['get_project', 'list_projects', 'list_tasks']);
    expect(call.system).toContain('Today is 2026-10-27');
    expect(PERSONA_MAX_STEPS).toBe(6);
  });

  it('offers no tools at all to a user who may read nothing', async () => {
    const call = await buildPersonaCall({ ...base, holds: holdsPermissions(['tasks:create']) });
    expect(call.tools).toBeUndefined();
    expect(call.toolNames).toEqual([]);
  });

  it('uses the user\'s own day for "today", not the server\'s', async () => {
    // 23:30 UTC on the 26th is already the 27th in Amsterdam.
    const call = await buildPersonaCall({
      ...base,
      now: new Date('2026-10-26T23:30:00Z'),
      holds: holdsPermissions(['tasks:read']),
    });
    expect(call.system).toContain('Today is 2026-10-27 (Europe/Amsterdam)');
  });
});

/** A model that runs `script` request by request. */
function scriptedModel(script: Array<{ tool?: { name: string; input: unknown }; text?: string }>) {
  let call = 0;
  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  });
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      return {
        content: step.tool
          ? [
              {
                type: 'tool-call' as const,
                toolCallId: `call_${call}`,
                toolName: step.tool.name,
                input: JSON.stringify(step.tool.input),
              },
            ]
          : [{ type: 'text' as const, text: step.text ?? '' }],
        finishReason: { unified: step.tool ? ('tool-calls' as const) : ('stop' as const), raw: undefined },
        usage: usage(100, 10),
        warnings: [],
      };
    },
  });
  return model;
}

function fakeTool(
  overrides: Partial<PlatformToolDefinition> & Pick<PlatformToolDefinition, 'name'>,
): PlatformToolDefinition {
  return {
    id: `test.${overrides.name}`,
    description: 'A test tool',
    requiredPermissions: [],
    parameters: z.object({ q: z.string().optional() }),
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

const ctx: ToolContext = { db: {} as never, agentId: 'agt_persona', actorUserId: 'user_1', workspaceId: 'org_1' };

describe('a reply with lookups', () => {
  it('runs the tool, feeds the result back, answers from it, and adds up every request', async () => {
    const execute = vi.fn(async () => ({ totalCount: 2, tasks: [{ title: 'Overdue report' }, { title: 'Due today' }] }));
    const tools = buildPersonaToolSet([fakeTool({ name: 'list_tasks', execute })], ctx);
    const model = scriptedModel([
      { tool: { name: 'list_tasks', input: { q: 'x' } } },
      { text: 'You have 2 tasks: Overdue report and Due today.' },
    ]);

    const result = await generateText({
      model,
      system: 'test',
      messages: [{ role: 'user', content: 'What is on my plate today?' }],
      tools,
      stopWhen: stepCountIs(PERSONA_MAX_STEPS),
    });

    // The tool runs against the caller's context, with the arguments the model gave.
    expect(execute).toHaveBeenCalledWith(ctx, { q: 'x' });
    expect(result.text).toBe('You have 2 tasks: Overdue report and Due today.');
    expect(result.steps).toHaveLength(2);
    // The second request saw the tool's result.
    const secondPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(secondPrompt).toContain('Overdue report');
    // Billing: usage is the sum of both model requests, not just the last one.
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(20);
    expect(sumStepUsage(result.steps)).toEqual({ inputTokens: 200, outputTokens: 20, totalTokens: 220 });
  });

  it('answers the model with an error (not a failed reply) when a lookup throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tools = buildPersonaToolSet(
      [
        fakeTool({
          name: 'list_tasks',
          execute: async () => {
            throw new Error('connection reset to db.internal:5432');
          },
        }),
      ],
      ctx,
    );
    const model = scriptedModel([{ tool: { name: 'list_tasks', input: {} } }, { text: "I couldn't check that right now." }]);

    const result = await generateText({
      model,
      messages: [{ role: 'user', content: 'Show my tasks' }],
      tools,
      stopWhen: stepCountIs(PERSONA_MAX_STEPS),
    });

    expect(result.text).toBe("I couldn't check that right now.");
    // The model is told the lookup failed, without the internal error text.
    const secondPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(secondPrompt).toContain('The lookup failed');
    expect(secondPrompt).not.toContain('db.internal');
    warn.mockRestore();
  });

  it('stops at the step limit instead of looping on lookups', async () => {
    const execute = vi.fn(async () => ({ more: true }));
    const tools = buildPersonaToolSet([fakeTool({ name: 'list_tasks', execute })], ctx);
    const model = scriptedModel([{ tool: { name: 'list_tasks', input: {} } }]);

    const result = await generateText({
      model,
      messages: [{ role: 'user', content: 'Keep looking' }],
      tools,
      stopWhen: stepCountIs(PERSONA_MAX_STEPS),
    });

    expect(result.steps).toHaveLength(PERSONA_MAX_STEPS);
    expect(execute).toHaveBeenCalledTimes(PERSONA_MAX_STEPS);
    // Nothing written: the caller shows a plain apology rather than an empty reply.
    expect(personaReplyText(result.text)).toBe(PERSONA_FALLBACK_TEXT);
  });
});

describe('createPersonaTextTransform', () => {
  async function run(parts: Array<{ type: string; text?: string }>): Promise<string> {
    const source = new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const reader = source.pipeThrough(createPersonaTextTransform()).getReader();
    let out = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return out;
      out += value;
    }
  }

  it('streams the text deltas and nothing else', async () => {
    expect(
      await run([
        { type: 'start' },
        { type: 'tool-call' },
        { type: 'text-delta', text: 'You have ' },
        { type: 'text-delta', text: '2 tasks.' },
        { type: 'finish-step' },
        { type: 'finish' },
      ]),
    ).toBe('You have 2 tasks.');
  });

  it('sets the text of one model request apart from the next with a blank line', async () => {
    expect(
      await run([
        { type: 'text-delta', text: 'Let me check.' },
        { type: 'finish-step' },
        { type: 'finish-step' },
        { type: 'text-delta', text: 'You have 2 tasks.' },
        { type: 'finish-step' },
      ]),
    ).toBe('Let me check.\n\nYou have 2 tasks.');
  });

  it('does not add a separator after a request that wrote nothing', async () => {
    expect(
      await run([{ type: 'finish-step' }, { type: 'text-delta', text: 'Answer.' }, { type: 'finish-step' }]),
    ).toBe('Answer.');
  });

  it('answers with an apology when the model wrote nothing (a failed or empty reply)', async () => {
    expect(await run([{ type: 'error' }, { type: 'finish-step' }])).toBe(PERSONA_FALLBACK_TEXT);
    expect(await run([])).toBe(PERSONA_FALLBACK_TEXT);
  });

  it('works on a real streamed reply with lookups', async () => {
    const tools = buildPersonaToolSet([fakeTool({ name: 'list_tasks', execute: async () => ({ totalCount: 0, tasks: [] }) })], ctx);
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        const first = call === 1;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              if (first) {
                controller.enqueue({ type: 'tool-call', toolCallId: 'c1', toolName: 'list_tasks', input: '{}' });
              } else {
                controller.enqueue({ type: 'text-start', id: 't1' });
                controller.enqueue({ type: 'text-delta', id: 't1', delta: 'Nothing is due.' });
                controller.enqueue({ type: 'text-end', id: 't1' });
              }
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined },
                usage: {
                  inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 5, text: 5, reasoning: undefined },
                },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const finished = vi.fn();
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'What is on my plate?' }],
      tools,
      stopWhen: stepCountIs(PERSONA_MAX_STEPS),
      onFinish: (event) => finished(event.usage),
    });
    const reader = result.fullStream.pipeThrough(createPersonaTextTransform()).getReader();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += value;
    }
    expect(text).toBe('Nothing is due.');
    // The stream's usage covers both model requests (what the route bills).
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][0]).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });
});

describe('spreadsheets the user points at', () => {
  const open = { id: 'sht_open', name: 'Budget', tab: 'Q3', selection: 'B2:D9' };
  const sheetIds = (permissions: string[], sheets?: PersonaSheets) =>
    selectPersonaSheetTools(holdsPermissions(permissions), sheets).map((t) => t.id);

  it('offers no spreadsheet tools without a sheet to work on', () => {
    expect(sheetIds(['*'])).toEqual([]);
    expect(sheetIds(['*'], { open: null, tagged: [] })).toEqual([]);
  });

  it('reads with sheets:read and writes only with sheets:update as well', () => {
    expect(sheetIds(['sheets:read'], { open })).toEqual(['sheets.list_tabs', 'sheets.read_range']);
    expect(sheetIds(['sheets:read', 'sheets:update'], { open })).toEqual([
      'sheets.list_tabs',
      'sheets.read_range',
      'sheets.write_range',
    ]);
    expect(sheetIds(['sheets:update'], { open })).toEqual([]);
    expect(sheetIds(['weldsheets:sheets:read'], { tagged: [{ id: 'sht_1', label: 'Forecast' }] })).toEqual([
      'sheets.list_tabs',
      'sheets.read_range',
    ]);
  });

  it('never offers finding or creating spreadsheets', () => {
    const names = selectPersonaSheetTools(() => true, { open }).map((t) => t.name);
    expect(names).not.toContain('find_spreadsheets');
    expect(names).not.toContain('create_spreadsheet');
  });

  it('lists the open sheet first and each sheet once', () => {
    expect(personaSheetIds({ open, tagged: [{ id: 'sht_2', label: null }, { id: 'sht_open', label: 'Budget' }] })).toEqual([
      'sht_open',
      'sht_2',
    ]);
  });

  it('consults the spreadsheet permissions', () => {
    expect(personaPermissionKeys()).toEqual(expect.arrayContaining(['sheets:read', 'sheets:update']));
  });

  it('refuses a spreadsheet the user did not open or tag, before calling sheets-api', async () => {
    const fetch = vi.fn();
    const ctx = { db: {} as never, agentId: 'agt_x', actorUserId: 'user_1', workspaceId: 'ws_1', env: { SHEETS_INTERNAL: { fetch } } } as unknown as ToolContext;
    const [, read] = sheetToolsLimitedTo(['sht_open']);
    expect(await read.execute(ctx, { spreadsheetId: 'sht_other' })).toEqual({
      error: 'You can only work in the spreadsheet the user has open or tagged.',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('works on an allowed spreadsheet as the user, through sheets-api', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { values: [[1]] } }), { status: 200 }));
    const ctx = { db: {} as never, agentId: 'agt_x', actorUserId: 'user_1', workspaceId: 'ws_1', env: { SHEETS_INTERNAL: { fetch } } } as unknown as ToolContext;
    const [, read] = sheetToolsLimitedTo(['sht_open']);
    expect(await read.execute(ctx, { spreadsheetId: 'sht_open', range: 'A1' })).toEqual({ values: [[1]] });
    expect(fetch).toHaveBeenCalledWith(
      'https://sheets-api.internal/internal/agent/ws_1/sheets/sht_open/read',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-weld-user': 'user_1' }) }),
    );
  });

  it('tells it which sheet is open, where the user is, and how to change it', () => {
    const text = buildPersonaSystem({
      tools: selectPersonaSheetTools(holdsPermissions(['sheets:read', 'sheets:update']), { open }),
      sheets: { open, tagged: [{ id: 'sht_2', label: 'Forecast' }] },
      today: '2026-10-27',
    });
    expect(text).toContain('SPREADSHEETS');
    expect(text).toContain('The user has the spreadsheet "Budget" open (spreadsheetId sht_open), on the tab "Q3", with B2:D9 selected.');
    expect(text).toContain('The user tagged: "Forecast" (spreadsheetId sht_2).');
    expect(text).toContain('read and change these spreadsheets, and only these');
    expect(text).toContain('Only the spreadsheets below');
    expect(text).not.toContain('you have no lookup tools for this user, so you cannot read');
  });

  it('says it may only read when the user cannot edit spreadsheets', () => {
    const text = buildPersonaSystem({
      tools: selectPersonaSheetTools(holdsPermissions(['sheets:read']), { open }),
      sheets: { open },
      today: '2026-10-27',
    });
    expect(text).toContain('You cannot change them');
    expect(text).not.toContain('write_spreadsheet_range');
  });

  it('gets more steps when it has a sheet to work on', async () => {
    const call = await buildPersonaCall({
      db: {} as never,
      workspaceId: 'ws_1',
      userId: 'user_1',
      timezone: 'Europe/Amsterdam',
      holds: holdsPermissions(['sheets:read', 'sheets:update']),
      sheets: { open },
    });
    expect(call.toolNames).toEqual(['list_spreadsheet_tabs', 'read_spreadsheet_range', 'write_spreadsheet_range']);
    expect(PERSONA_SHEET_MAX_STEPS).toBeGreaterThan(PERSONA_MAX_STEPS);
  });
});
