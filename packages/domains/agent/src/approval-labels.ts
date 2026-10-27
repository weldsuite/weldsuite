/**
 * What an action held for approval says in words.
 *
 * People are shown "Create task "QA agent chat task"", never `create_task`:
 * the label on the approval card and notification, and the note the agent
 * posts once the action is decided.
 */

interface ToolAction {
  /** The action as a heading ("Create task"). */
  pending: string;
  /** After "I did not" / "I could not" ("create the task"). */
  infinitive: string;
  /** After "Approved — " ("created the task"). */
  past: string;
  /** The record's name, from the call's arguments. */
  name?: (args: Record<string, unknown>) => string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const ACTIONS: Record<string, ToolAction> = {
  create_task: {
    pending: 'Create task',
    infinitive: 'create the task',
    past: 'created the task',
    name: (a) => text(a.title),
  },
  create_person: {
    pending: 'Create person',
    infinitive: 'create the person',
    past: 'created the person',
    name: (a) => [text(a.firstName), text(a.lastName)].filter(Boolean).join(' ') || text(a.email),
  },
  create_ticket: {
    pending: 'Create ticket',
    infinitive: 'create the ticket',
    past: 'created the ticket',
    name: (a) => text(a.subject),
  },
  create_spreadsheet: {
    pending: 'Create spreadsheet',
    infinitive: 'create the spreadsheet',
    past: 'created the spreadsheet',
    name: (a) => text(a.name),
  },
  write_spreadsheet_range: {
    pending: 'Update a spreadsheet',
    infinitive: 'update the spreadsheet',
    past: 'updated the spreadsheet',
  },
  message_agent: { pending: 'Message another agent', infinitive: 'message the agent', past: 'messaged the agent' },
  create_agent_group_chat: {
    pending: 'Create group chat',
    infinitive: 'create the group chat',
    past: 'created the group chat',
    name: (a) => text(a.name),
  },
  computer_exec: { pending: 'Run a command in the sandbox', infinitive: 'run the command', past: 'ran the command' },
  computer_write_file: {
    pending: 'Write a file in the sandbox',
    infinitive: 'write the file',
    past: 'wrote the file',
  },
  computer_run_code: { pending: 'Run code in the sandbox', infinitive: 'run the code', past: 'ran the code' },
  browser_act: { pending: 'Use the browser', infinitive: 'use the browser', past: 'used the browser' },
};

const UNKNOWN_ACTION: ToolAction = {
  pending: 'Run an action',
  infinitive: 'run that action',
  past: 'ran that action',
};

const NAME_MAX_CHARS = 80;

function argsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The record's name: from what the tool returned when it ran, else from its arguments. */
function recordName(action: ToolAction, args: unknown, result?: unknown): string | null {
  const returned = argsOf(result);
  const fromResult = text(returned.title) ?? text(returned.fullName) ?? text(returned.subject) ?? text(returned.name);
  const name = fromResult ?? action.name?.(argsOf(args)) ?? null;
  if (!name) return null;
  return name.length > NAME_MAX_CHARS ? `${name.slice(0, NAME_MAX_CHARS - 1)}…` : name;
}

function describe(toolName: string, args: unknown, result?: unknown) {
  const action = ACTIONS[toolName] ?? UNKNOWN_ACTION;
  return { action, name: recordName(action, args, result) };
}

const quoted = (name: string | null): string => (name ? ` "${name}"` : '');

/** The action waiting for approval: `Create task "QA agent chat task"`. */
export function approvalLabel(toolName: string, args: unknown): string {
  const { action, name } = describe(toolName, args);
  return `${action.pending}${quoted(name)}`;
}

/** The note after an approved action ran: `Approved — created the task "QA agent chat task".` */
export function approvedOutcome(toolName: string, args: unknown, result: unknown): string {
  const { action, name } = describe(toolName, args, result);
  return `Approved — ${action.past}${quoted(name)}.`;
}

/** The note after an action was rejected. */
export function rejectedOutcome(toolName: string, args: unknown): string {
  const { action, name } = describe(toolName, args);
  return `Rejected — I did not ${action.infinitive}${quoted(name)}.`;
}

/** The note after an approved action failed to run. */
export function failedOutcome(toolName: string, args: unknown, error: string): string {
  const { action, name } = describe(toolName, args);
  return `Approved, but I could not ${action.infinitive}${quoted(name)}: ${error}`;
}

/** What the model is told about an action that is held: no id to repeat, and what to say. */
export function heldForApprovalMessage(label: string): string {
  return (
    `Held for approval: ${label}. It has NOT run yet; it runs once the user approves it. ` +
    'Tell the user it is waiting for their approval (the Approve button on the agent page, or in the channel). ' +
    'Do not mention ids or tool names, do not retry it, and do not say it is done.'
  );
}

/** An action held for approval, as carried on the agent's reply in a room (`metadata.approvals`). */
export interface ChannelApproval {
  id: string;
  label: string;
  status: 'pending';
}

/** The approvals a turn parked, from its stored tool steps (a held step carries its approval id and label). */
export function pendingApprovalsOf(invocations: ReadonlyArray<{ result?: unknown }>): ChannelApproval[] {
  const approvals: ChannelApproval[] = [];
  for (const { result } of invocations) {
    const held = argsOf(result);
    if (held.pendingApproval !== true || typeof held.approvalId !== 'string') continue;
    approvals.push({
      id: held.approvalId,
      label: text(held.label) ?? UNKNOWN_ACTION.pending,
      status: 'pending',
    });
  }
  return approvals;
}

/** What the agent posts in a room when it parked actions and wrote nothing else. */
export function approvalsNotice(approvals: readonly ChannelApproval[]): string {
  return `This needs your approval before I can do it: ${approvals.map((approval) => approval.label).join('; ')}.`;
}

/**
 * Who hears about a held action: the agent's owner (unless they asked
 * themselves and see it in their chat), and whoever asked in a room, where
 * there is no chat of theirs to show it.
 */
export function approvalRecipients(params: {
  ownerId: string | null | undefined;
  actorUserId: string | null | undefined;
  inChannel: boolean;
}): string[] {
  const { ownerId, actorUserId, inChannel } = params;
  const recipients = new Set<string>();
  if (ownerId && ownerId !== actorUserId) recipients.add(ownerId);
  if (inChannel && actorUserId && actorUserId !== 'system') recipients.add(actorUserId);
  return [...recipients];
}
