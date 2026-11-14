---
title: Users and profiles
nextjs:
  metadata:
    title: Users and profiles
    description: Find the people who visit your site, read their profile and activity, see their website activity in WeldCRM, and erase a person on request.
screenshots_todo:
  - file: weldpanel-users.png
    shows: The Users list with the search box, the cohort filter and identified and anonymous visitors
  - file: weldpanel-profile.png
    shows: A user profile on the Overview tab with first and last seen, properties, anonymous ids and the Open in WeldCRM button
  - file: weldpanel-crm-website-activity.png
    shows: A WeldCRM person with the Website activity card showing last seen, recent activity and recordings
---

**Users** lists the people your site has identified. Open someone to see their properties, what they did and their recordings. {% .lead %}

Seeing users needs the **View tracked user profiles** permission, because a profile can hold an email address.

---

## Find a person

Open **Users** under **Behaviour**.

- **Search** by name, email or id.
- Pick a **Cohort** to see only the people in it, or **All users**.

The list shows each person with their email, when they were first and last seen, and their properties.

A person appears here once your site calls `identify()` for them, or your server sets profile properties for them. Call `people.set()` to give them a name and email. See [Track events and identify users](/weldpanel/track-events). Anonymous visitors are counted in your reports and can be watched in **Recordings**, but have no profile.

---

## A person's profile

Click a person to open their profile. It has three tabs:

- **Overview**: **First seen**, **Last seen**, **Events (90 days)**, **Recent sessions**, the **User id**, the **Anonymous ids** linked to it (one per browser or device) and all **Properties**.
- **Activity**: their events of the last 90 days, newest first.
- **Recordings**: their recorded visits. Click **Watch** to open one.

When a WeldCRM person has the same email as the profile, **Open in WeldCRM** takes you to them.

---

## Website activity in WeldCRM

When a WeldCRM person's email matches the email of a WeldPanel profile, the person's page shows a **Website activity** card:

- when they were last on your site;
- their **Recent activity**, such as the pages they viewed;
- their **Recordings**, with a link to watch each visit;
- **Open in WeldPanel**, to their full profile.

If they visited more than one of your projects, the card shows each project.

The card only reads from WeldPanel. Nothing is written to WeldCRM, and no CRM person is created for a visitor. It shows when WeldPanel is installed and you can see user profiles. A person who never visited gets no card.

---

## Erase a person

To act on a request to delete someone's data, for example under the GDPR:

1. Open the person's profile in the project.
2. Click **Erase this person**.
3. Type the name shown to confirm, then click **Erase person**.

What happens:

- The profile and the links to their anonymous ids are removed at once. From then on, reports, the Users list and recordings leave the person out.
- Their recordings are deleted from storage at once, favourites included.
- The rest of their events are rewritten out of the analytics tables within a month.

This cannot be undone.

Erasing works per project. If the person used more than one of your projects, erase them in each. Search the **Users** list by their email to find them.

Erasing needs the **Erase tracked users** permission, which owners and admins have by default.
