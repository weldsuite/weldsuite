---
title: Logic and quizzes
nextjs:
  metadata:
    title: Logic and quizzes
    description: Branch a form on answers, calculate with variables, reuse answers in text, and build scored quizzes.
---

Make a form adapt to the answers it gets, and turn it into a scored quiz. {% .lead %}

---

## Jumps

On any block, add rules of the form "if *conditions*, go to *block*". Rules are checked in order, and an **Otherwise** rule says where to go when none match.

Conditions can be combined with AND and OR groups and can test any earlier answer, hidden field or variable. The operators follow the type of the answer: is, is not, contains, starts with, greater than, less than, between, before, after, is answered, is empty, any of, all of and none of.

The **Logic** tab shows every jump as a diagram next to the rule list, so you can see dead ends and loops at a glance.

In the **classic** layout the same rules show or hide questions and jump between pages.

---

{% figure src="/images/help/weldforms-logic.png" alt="The Logic tab with a jump on an NPS question" caption="A jump sends unhappy respondents to a follow-up question." /%}

## Variables

A variable is a number or a piece of text that logic updates as the respondent answers. An action on an answer can add, subtract, multiply, divide or set a variable. That is enough for assessments, lead scoring and simple price quotes. The built-in variable is `score`.

---

## Recall

Use an earlier answer in later text with double curly braces:

| Write | Shows |
| --- | --- |
| `{{field:company_size}}` | The answer to the block with the ref `company_size` |
| `{{hidden:utm_source}}` | The value of a hidden field |
| `{{var:score}}` | The value of a variable |

Recall works in titles, descriptions, ending screens, redirect URLs and emails.

---

## Endings

A form can have several ending screens. Logic picks one by answers or by score. An ending can also redirect to another URL, with recall in the query string, for example to pass the score to your own page.

---

## Quizzes

Turn a form into a quiz by giving questions a correct answer and points per choice. Points add up in `score`. An ending screen can then show the score and, if you choose, the correct answers. Combine it with ending rules ("score of 8 or more") to show different endings to different results.

{% callout title="The server checks the path" %}
When someone submits, WeldForms replays your logic over the submitted answers. Answers to blocks that were not on the respondent's path are dropped, required questions on the path are checked, and the score and ending are calculated again. A tampered browser cannot award itself points.
{% /callout %}
