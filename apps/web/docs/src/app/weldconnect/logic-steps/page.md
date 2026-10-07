---
title: Logic steps
nextjs:
  metadata:
    title: Logic steps
    description: Branch with conditions, repeat steps with loops, wait with delays and pause for approvals in WeldConnect.
screenshots_todo:
  - file: weldconnect-condition-branches.png
    shows: Canvas with a Condition step and steps under its If true and If false branches, plus a step after the condition
  - file: weldconnect-loop.png
    shows: Canvas with a Loop step, a step under "For each item", and the Loop settings panel (Items to Iterate)
  - file: weldconnect-approval-step.png
    shows: Approval step settings panel with Title, Instructions and Approvers filled in
  - file: weldconnect-approval-panel.png
    shows: Run page of a run that is "Waiting for approval", with the approval panel (Approvers, Comment, Approve / Reject)
---

Logic steps control the flow of a workflow: take a different path, repeat steps for each item in a list, wait, or pause until someone approves. Find them under **Logic & Flow** when you add a step. {% .lead %}

---

## Conditions

A **Condition** checks a value and splits the workflow into two branches: **If true** and **If false**.

1. Add a **Condition** step.
2. Set **Field to Check**, usually a variable such as `{{trigger.record.status}}`.
3. Choose the **Operator**: **Equals**, **Not Equals**, **Greater Than**, **Less Than**, **Contains**, **Starts With**, **Ends With**, **Is Empty**, **Is Not Empty**, **In List**, **Matches Regex** and more.
4. Enter the **Value** to compare against (not needed for **Is Empty** / **Is Not Empty**).
5. On the canvas, add the steps for each outcome under **If true** and **If false**. A branch may stay empty.

Only the matching branch runs; the steps of the other branch show as **Skipped** in the run. After the branch, the workflow continues with the step after the condition. Use **Add step after this condition** to add one.

Branches can contain other conditions and loops.

---

## Loops

A **Loop** repeats steps once for every item in a list, for example every line of an order a webhook sent.

1. Add a **Loop** step.
2. Set **Items to Iterate** to a list, for example `{{trigger.body.lines}}`.
3. Add the steps to repeat under **For each item** on the canvas.

Inside the loop, `{{loop.item}}` is the current item and `{{loop.index}}` its position, starting at 0. For a list of objects, use a field of the item: `{{loop.item.sku}}`. After the last item, the workflow continues with the step after the loop (use **Add step after this loop**).

Limits:

- A loop runs over **at most 100 items**. A longer list fails the step.
- A run can do **at most 250 loop iterations** in total, across all its loops.
- If a step inside the loop fails, the loop fails with the item number in the error (for example `Item 3: …`).

---

## Delays

A **Delay** pauses the run before the next step.

1. Add a **Delay** step.
2. Set the **Wait Duration** and choose **Seconds**, **Minutes**, **Hours** or **Days**.

A delay can wait **up to 365 days**. While it waits, the run shows as **Running**; you can cancel it from the run page.

---

## Approvals

An **Approval** pauses the run until a person approves or rejects it. Use it for anything that needs a human decision first: a refund, a discount, a message to a big customer.

1. Add an **Approval** step.
2. Enter a **Title** (shown in the notification and on the run page), for example `Approve refund for {{trigger.record.name}}`.
3. Add **Instructions**: what the approver should check before deciding.
4. Choose the **Approvers**.
5. To act on the decision, add a **Condition** after the approval on its **Approved** output (`{{steps.<approval>.approved}}` equals `true`), with the follow-up steps under **If true** and **If false**.

### What happens during a run

- The run's status changes to **Waiting for approval**. You can filter on it in **Executions**.
- Each approver gets an in-app notification that opens the run.
- On the run page, an approver can add a **Comment** and click **Approve** or **Reject**. The run then continues. Only one decision counts: if someone already decided, you see "Someone already decided on this approval".
- People who are not approvers see "Only the approvers of this step can decide."
- Without approvers, the workflow owner is notified and anyone who can manage workflow runs can decide.

The approval's output for later steps: `approved` (true or false), `decision` (`approved` or `rejected`), `comment`, `decidedBy`, `decidedByName` and `decidedAt`.

{% callout type="warning" title="Limits" %}
- If nobody decides within **7 days**, the step fails with "Approval expired: nobody approved or rejected this step within 7 days".
- An approval must be in the main flow. It **can't sit inside a branch or a loop**; the editor flags it and blocks publishing.
- Approvers who are no longer workspace members are skipped. If none are left, the step fails.
{% /callout %}

You can cancel a run that is waiting for approval from the run page.

---

## Next steps

- [WeldSuite steps](/weldconnect/weldsuite-steps)
- [Runs and history](/weldconnect/runs-and-history)
