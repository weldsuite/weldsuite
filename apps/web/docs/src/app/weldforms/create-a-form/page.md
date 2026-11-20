---
title: Create a form
nextjs:
  metadata:
    title: Create a form
    description: Start a WeldForms form from a template or with AI, add blocks, and publish it.
---

Build a form, check it in the preview, and publish it to get a link. {% .lead %}

---

## Start a form

1. Open **WeldForms** from the app rail.
2. Click **New form**.
3. Choose how to begin:
   - **Blank**: an empty form.
   - **Template**: a ready-made form, including your workspace's own templates.
   - **AI**: describe the form you want and review the draft it writes. Available on Global only, and charged to your AI credits.
4. Give the form a title. It opens in the builder.

The home page shows all your forms with their status, response count and completion rate. Use folders to group them and search to find one.

---

## Add blocks

On the **Create** tab, the outline on the left lists the blocks in order. Drag a block to reorder it and use the add-block menu to insert one. The preview in the middle updates as you type; switch it between desktop and phone, and between the two layouts. The properties on the right hold the settings, validation and logic of the selected block.

| Group | Blocks |
| --- | --- |
| Text | Short text, long text, email, phone, number, website, date |
| Choice | Multiple choice (one or several, with "Other" and random order), dropdown, picture choice, yes/no, legal (accept terms) |
| Scales | Rating, opinion scale, NPS, ranking, matrix |
| Files | File upload, signature |
| Composite | Contact info, address |
| Layout | Welcome screen, statement, question group, page break (classic layout only), ending screens |

Every question can be required, have a description, an image or video, and validation such as length, range or number of choices. Give a block a short **ref** (for example `company_size`) to use it in recall, prefilled links, integrations and exports. Refs can be edited; the block's internal id never changes.

Your changes are saved as a draft automatically.

---

{% figure src="/images/help/weldforms-builder.png" alt="The WeldForms builder with the question outline and a live preview" caption="The outline on the left, the live preview in the middle and the settings of the selected question on the right." /%}

## Hidden fields and variables

**Hidden fields** are values that arrive with the respondent, through the link or an embed, such as `source` or `plan`. They are stored with the response and can be used in logic and recall. **Variables** hold numbers or text that logic changes while the form is filled in; `score` is built in. See [Logic and quizzes](/weldforms/logic-and-quizzes).

---

## Preview

**Preview** opens the real form exactly as respondents see it. Nothing you enter there is stored or counted.

---

## Publish

1. Click **Publish**.
2. Copy the link from the **Share** tab.

Publishing takes a snapshot of the form, called a version. Later edits change only the draft until you click **Publish changes**. Someone halfway through a form finishes on the version they started, and every response is kept with the version it answered.

You can **close** a form at any time, or set open and close dates and a response limit in **Settings**.

{% callout title="Publishing is screened" %}
Publishing runs a quick check for forms that ask for passwords or imitate another brand. A form that looks suspicious is held for review by WeldSuite staff and stays offline until it is released. See [Privacy and safety](/weldforms/privacy-and-safety).
{% /callout %}

---

## Next steps

- [Logic and quizzes](/weldforms/logic-and-quizzes)
- [Design and themes](/weldforms/design-and-themes)
- [Share a form](/weldforms/share-a-form)
