---
title: Reports, dashboards and cohorts
nextjs:
  metadata:
    title: Reports, dashboards and cohorts
    description: Save WeldPanel analyses as reports, put them side by side on dashboards, and define cohorts of people to filter by.
screenshots_todo:
  - file: weldpanel-reports.png
    shows: The Reports list with the Show and Type filters, and reports of different types and visibility
  - file: weldpanel-dashboard.png
    shows: A dashboard with four report tiles and the tile menu open
  - file: weldpanel-cohort.png
    shows: The New cohort dialog with a User property condition and a Did an event condition
---

Keep the analyses you use often as **reports**, put them side by side on **dashboards**, and save groups of people as **cohorts** to filter any report by. {% .lead %}

Reports, dashboards and cohorts belong to one project.

---

## Save a report

On **Insights**, **Funnels**, **Retention** or **Flows**:

1. Build the analysis.
2. Click **Save as report**.
3. Enter a **Name** and, optionally, a **Description**.
4. Choose the **Visibility**:
   - **Private**: only you can see it.
   - **Workspace**: everyone in the workspace can see it.
5. Save.

When you open a saved report and change it, click **Save changes** to update it, or **Save as new report** to keep both.

A report saved with a period such as **Last 30 days** shows fresh numbers every time you open it.

---

## Find your reports

**Reports** (under **Saved**) lists the reports of the current project.

- **Show**: **All reports**, **My reports** or **Shared reports**.
- **Type**: **Insight**, **Funnel**, **Retention** or **Flow**.
- **New report** starts a new analysis of the type you pick.

The menu on each report has **Open**, **Rename**, **Make private** or **Share with the workspace**, and **Delete**. A deleted report is also removed from every dashboard it was on.

---

## Dashboards

A dashboard puts saved reports on one page.

1. Open **Dashboards** and click **New dashboard**.
2. Give it a name and a visibility (**Private** or **Workspace**).
3. Click **Add report** and choose a saved report.

You can also click **Add to dashboard** while building an analysis. An analysis that is not saved yet is saved as a report first.

Each tile has a menu with **Open report**, **Remove from dashboard**, **Move earlier**, **Move later**, **Wider**, **Narrower**, **Taller** and **Shorter**.

A tile shows "This report was deleted or is not shared with you" when its report is gone, or private to someone else. Deleting a dashboard keeps its reports.

---

## Cohorts

A cohort is a saved group of people, such as "signed up in the last 30 days and did not upgrade". Use it to filter reports, the Overview, the **Users** list and recordings.

1. Open **Cohorts** and click **New cohort**.
2. Enter a name.
3. Under **Match**, choose **all conditions** or **any condition**.
4. Add conditions:
   - **User property**: a profile property, an operator and a value, for example `plan` **is** `trial`.
   - **Did an event**: **Did it** at least a number of times in the last so many days, or **Did not do it** in that time. Use **Only when** to count only events with certain properties.
5. Save.

To use a cohort, add a filter and choose **Cohort**, then **In cohort** or **Not in cohort**.

Deleting a cohort stops the reports that filter on it from working until you pick another cohort.

User properties come from `people.set()`. See [Track events and identify users](/weldpanel/track-events#keep-the-profile-up-to-date).

---

## Permissions

Creating, changing and deleting reports, dashboards and cohorts each need their own report permission. Members have them by default. Viewers can open reports and dashboards that are shared with the workspace.
