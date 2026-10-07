---
title: Runs and history
nextjs:
  metadata:
    title: Runs and history
    description: Follow WeldConnect runs, cancel and retry them, work through the error log, limit concurrent runs and restore earlier workflow versions.
screenshots_todo:
  - file: weldconnect-executions-list.png
    shows: WeldConnect → Executions with runs in several statuses (Completed, Failed, Waiting for approval, Skipped, Test badge) and the Status filter
  - file: weldconnect-run-page.png
    shows: A run page with the Execution Steps tab, one step expanded showing its input and output, and the Cancel / Retry buttons
  - file: weldconnect-error-log.png
    shows: Analytics → Errors tab with the Error Log (Open / All, Acknowledge, Acknowledge all)
  - file: weldconnect-version-history.png
    shows: Workflow Settings with the Version history dialog open (Activated / Saved / Restored badges and Restore buttons)
---

Every time a workflow runs, WeldConnect records the run: its status, what went in, what each step did and what went wrong. {% .lead %}

---

## Find runs

- **All workflows**: **WeldConnect** → **Executions**. Filter by **Status**, **Trigger** or **Workflow**, or search.
- **One workflow**: open the workflow and choose the **Executions** tab, or open **Run history** in the editor.

Runs started with **Test** have a **Test** badge.

### Statuses

| Status | Meaning |
| --- | --- |
| **Queued** | Accepted, about to start |
| **Running** | Steps are running, or a Delay is waiting |
| **Waiting for approval** | Paused at an [Approval](/weldconnect/logic-steps#approvals) step |
| **Completed** | All steps finished |
| **Failed** | A step failed and the run stopped |
| **Cancelled** | Someone cancelled the run |
| **Skipped** | Not started because the workflow was at its [concurrent run limit](#limit-concurrent-runs) |

Inside a run, steps of a condition branch that didn't run show as **Skipped**.

---

## Read a run

Click a run (or **View Details**) to open it. The run page shows the status, the trigger, who or what started it, and its duration, with four tabs:

- **Execution Steps**: every step with its status. Expand a step for its input, output and error.
- **Input Data**: what the trigger delivered, for example the record or the webhook body.
- **Output Data**: what the run produced.
- **Logs**: the run's log lines.

A run that is still going updates live.

---

## Cancel a run

Click **Cancel** on the run page (or in the row menu of **Executions**) and confirm. You can cancel a run that is **Queued**, **Running** or **Waiting for approval**. It stops at once and stays **Cancelled**: it sends no notifications and doesn't start workflows that run after it.

---

## Retry a run

On a **Failed** run, click **Retry** to start a new run from the beginning with the same input. The new run links back with **Retry of**. The workflow must be active to retry; otherwise you see "Activate the workflow first, then retry this execution."

Fix the cause first (a missing permission, a disconnected app, a wrong field), otherwise the retry fails the same way. Steps that already succeeded in the failed run run again in the retry, so check for duplicates such as a second email.

---

## The error log

**WeldConnect** → **Analytics** → **Errors** has the **Error Log**: the failed steps of live runs, newest first.

1. Keep the filter on **Open** to see what still needs attention.
2. Click **View run** to open the run behind an error.
3. Once you have dealt with it, click **Acknowledge**. Use **Acknowledge all** to clear the list. Acknowledged errors stay visible under **All**.

An error has the severity **Error**, or **Warning** when the run continued past the failed step. Analytics also shows execution trends, success rate and durations. Test runs are not counted.

---

## Run notifications

On the workflow's **Settings** tab, under **Notifications**:

- **Get notified when this workflow fails** (on by default)
- **Get notified when this workflow completes** (off by default)

The workflow owner receives these as in-app notifications.

---

## Limit concurrent runs

To stop a busy trigger from starting many runs at once, set a limit on the workflow's **Settings** tab under **Concurrency**:

1. Enter **Maximum concurrent runs**, for example `1`.
2. Click **Save**.

While that many runs of the workflow are queued, running or waiting for approval, a new run is not started. It is recorded with the status **Skipped** instead, so you can see it happened. Leave the field empty for no limit.

Good to know:

- Test runs are never skipped.
- The limit applies to runs started by record events, schedules, webhooks and retries. Runs started by **After another workflow** are not limited yet.
- The limit is a safeguard, not an exact guarantee: two runs that start at the very same moment can both get through.

---

## Version history

WeldConnect keeps earlier versions of a workflow so you can go back after a change that didn't work out.

A version is saved when a workflow is **activated**, and every time an active workflow is saved with a change to its name, trigger, steps or settings. Drafts that were never activated have no versions yet.

### Restore a version

1. Open the workflow and go to the **Settings** tab.
2. Click **History**. The **Version history** dialog lists the versions, newest first, with who saved them and why (**Activated**, **Saved** or **Restored**).
3. Click **Restore** on the version you want and confirm.

Restoring replaces the workflow's trigger, steps and settings with that version, and is saved as a new version itself, so nothing is lost. Schedules and webhook URLs follow the restored trigger.

If the workflow is active and the old version uses something it can no longer use, the restore is refused with "This version uses triggers or actions this workflow can no longer use while active."

---

## Next steps

- [Create a workflow](/weldconnect/create-workflow)
- [Logic steps](/weldconnect/logic-steps)
- [WeldConnect overview](/weldconnect)
