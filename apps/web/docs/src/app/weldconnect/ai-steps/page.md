---
title: AI steps
nextjs:
  metadata:
    title: AI steps
    description: Generate and classify text with AI inside a WeldConnect workflow, and cap the AI credits a run may use.
screenshots_todo:
  - file: weldconnect-step-ai-classify.png
    shows: AI Classify step settings with Text to Classify mapped to a trigger variable and three categories
  - file: weldconnect-settings-quotas.png
    shows: Workflow Settings tab, Quotas section with "Maximum credits used per run" filled in
---

AI steps let a workflow write text or sort it into categories, for example draft a reply, summarise a ticket or decide whether a message is a complaint. {% .lead %}

Find them under **AI** when you add a step.

---

## AI Generate

Generates text from a prompt.

1. Add an **AI Generate** step.
2. Write the **Prompt**: the instruction for the model. Use variables to pass in data, for example `Write a two-line welcome message for {{trigger.record.firstName}} from {{trigger.record.companyName}}.`
3. Optionally add a **System Prompt** (the role or tone the model should take), choose a **Model** (leave it blank for the recommended default), and set **Temperature** and **Max Tokens**.

Use the result in later steps as `{{steps.<step>.text}}`, for example as the body of a **Send Email** or **Post Chat Message** step.

---

## AI Classify

Picks one category for a piece of text.

1. Add an **AI Classify** step.
2. Set **Text to Classify**, for example `{{trigger.record.description}}`.
3. Under **Categories**, type each category and press Enter, for example `complaint`, `question`, `praise`.
4. Optionally choose a **Model**.

The output has `category`, `confidence` and `reasoning`. Follow it with a [Condition](/weldconnect/logic-steps#conditions) on `{{steps.<step>.category}}` to handle each category differently.

---

## Credits

AI steps use your workspace's AI credits, the same balance other AI features in WeldSuite use. Each AI step's output includes `creditsUsed`, and the balance is under **Settings** → **Billing**.

When the workspace is out of credits, an AI step fails with a message about insufficient credits. The steps before it have already run.

### Cap the credits per run

To keep a single run from using too many credits, set a cap:

1. Open the workflow and go to the **Settings** tab.
2. Under **Quotas**, enter **Maximum credits used per run** (a whole number between 1 and 100,000).
3. Click **Save**.

Before every AI step, WeldConnect adds up the credits this run has already used and the most the next step could cost. If that would go over the cap, the step fails and says so; steps that ran before it are not undone. Leave the field empty for no limit.

---

## Next steps

- [Logic steps](/weldconnect/logic-steps)
- [Runs and history](/weldconnect/runs-and-history)
