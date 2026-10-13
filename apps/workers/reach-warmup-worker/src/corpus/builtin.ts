/**
 * The built-in English corpus: what the network sends until the first monthly
 * generated set exists, and whenever the stored set is missing or invalid.
 *
 * Each thread is 2 to 4 messages, written by the starter and the responder in
 * turn. `{{senderFirstName}}` is always the person writing a message and
 * `{{recipientFirstName}}` the person it is addressed to, so a reply greets
 * `{{recipientFirstName}}` and signs with `{{senderFirstName}}`.
 *
 * Plain text, no links, addresses, phone numbers or currency symbols, nothing
 * that marks the mail as anything but ordinary business correspondence.
 * Ids derive from the position: only ever append, never reorder or delete.
 */

import type { CorpusThread } from './types';

interface ThreadDraft {
  subject: string;
  /** Message bodies in order; even positions are the starter, odd the responder. */
  messages: readonly string[];
}

const DRAFTS: readonly ThreadDraft[] = [
  {
    subject: 'Call next week',
    messages: [
      `Hi {{recipientFirstName}},

Do you have 30 minutes sometime next week for a quick call? I'd like to go over the timeline for the rollout and hear how things look on your side. Tuesday afternoon or Thursday morning would work best for me.

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Thursday morning works. How about 10:00? I'll send a calendar invite once you confirm.

Speak then,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Following up on the quote',
    messages: [
      `Hi {{recipientFirstName}},

I wanted to follow up on the quote we sent over two weeks ago for the training sessions. Have you had a chance to look at it? Happy to adjust the scope if the number of participants has changed.

Best,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Thanks for the nudge, and sorry for the slow reply. I've shared it with our finance lead and expect an answer by Friday. The scope still looks right, but the group may grow from 12 to 15 people.

Regards,
{{senderFirstName}}`,
      `No problem at all. If it goes to 15 I'll send a revised version the same day so you can compare the two.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Question about your invoice',
    messages: [
      `Hello {{recipientFirstName}},

I received your invoice from last month, but it doesn't show a purchase order number. Our accounting team needs one to process it. Could you check whether you have it on file?

Thank you,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Good catch. Looking at our records, the order was placed under reference 4471. I'll issue a corrected invoice today.

Best,
{{senderFirstName}}`,
      `Perfect, that's the number I was missing. Once the corrected version arrives I'll get it into this week's payment run.

Thanks again,
{{senderFirstName}}`,
      `Great. It should be with you within the hour.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Migration status',
    messages: [
      `Hi {{recipientFirstName}}, quick check on where the migration stands. Are we still on track for the end of the month? I need to update the steering group on Wednesday.`,
      `Hi {{recipientFirstName}},

Mostly, yes. The data transfer finished on Monday and what's left is the acceptance round with the two departments that still use the old system. If they sign off by the 28th we're fine. The only risk is one team being away that week.

{{senderFirstName}}`,
      `Thanks, that's what I needed. I'll tell the group we're on track with one open point and ask the team in question to pick a day early.

Regards,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Introduction',
    messages: [
      `Hi {{recipientFirstName}},

I'd like to introduce myself. We work with a few of the same suppliers, and a mutual contact suggested we should talk. I'm responsible for partner relations at our company and I'm looking for ways to coordinate deliveries better. Would you be open to a short call in the next couple of weeks?

Kind regards,
{{senderFirstName}} {{senderLastName}}`,
      `Hi {{recipientFirstName}},

Nice to hear from you. Coordinating deliveries is something we have been thinking about as well, so the timing is good. Let's find 20 minutes. I'm usually at my desk after 2 pm.

Best,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'First conversation for the coordinator role',
    messages: [
      `Hi {{recipientFirstName}},

Thanks for applying for the operations coordinator role. We'd like to invite you for a first conversation of about 45 minutes, either in person or by video. Which days next week suit you?

Best regards,
{{senderFirstName}}`,
      `Hello {{recipientFirstName}},

Thank you, I'm glad to hear it. Video works well for me. Wednesday after lunch or any time on Friday would be fine.

Kind regards,
{{senderFirstName}}`,
      `Friday at 11:00 then. I'll send the link the day before. You'll be speaking with me and one of the team leads.

See you Friday,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Documents for supplier setup',
    messages: [
      `Hi {{recipientFirstName}},

Welcome aboard as one of our suppliers. To finish setting you up in our system I still need three things: your company registration details, the bank details for payments, and a contact person for invoices. Whenever you have a moment is fine.

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Thanks for the warm welcome. I can gather the registration and bank details today. For invoices, is it all right if I send you a name tomorrow? I need to check who is covering during the holidays.

{{senderFirstName}}`,
      `That's fine, tomorrow works. Just send it whenever you have it.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Headcount for the team day',
    messages: [
      `Hi {{recipientFirstName}}, I'm finalising the catering for the team day on the 24th. Do you already have a final headcount for your side? Last time you said around 18.`,
      `Hi {{recipientFirstName}},

It's 21 now. Two colleagues joined the project last week, and a client contact would like to come for the afternoon session. Is that still possible?`,
      `Should be fine, I'll tell the caterer 21 plus one. Any dietary requirements I should pass on?`,
      `Two vegetarians and one person who doesn't eat gluten. Everyone else is easy.

Thanks for sorting this out,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Thoughts on the draft proposal',
    messages: [
      `Hi {{recipientFirstName}},

I finished a first version of the proposal for the regional rollout and I'd really value your opinion before it goes further. In particular I'm unsure about the timeline section. Is it too ambitious?

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

I read it over lunch. The structure is clear and the summary on the first page is strong. On the timeline: yes, I think the second phase is tight. Three weeks for the training and the handover feels like five to me. I'd also add one line on who is responsible for each phase.

Best,
{{senderFirstName}}`,
      `That's very helpful, thank you. I'll stretch the second phase and add the owners. I'll send the new version on Monday in case you want another look.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Building access for next Monday',
    messages: [
      `Hello {{recipientFirstName}},

Three of my colleagues will visit your office on Monday. Could you let reception know, or tell me what they need to bring for the visitor passes?

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Done, I've informed reception. They only need a photo ID, and there are visitor parking spaces behind the building if anyone drives.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Good to meet you at the conference',
    messages: [
      `Hi {{recipientFirstName}},

It was good to meet you at the conference last week. I enjoyed the conversation about running a distributed support team. I hope the trip home was smoother than mine, my train was an hour late.

{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Likewise! Mine was fine, I got lucky for once. I'm still thinking about the point you made on handovers between time zones. Let's keep in touch, and let me know if you're ever in town.

Cheers,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Thank you for yesterday',
    messages: [
      `Hi {{recipientFirstName}},

Just a short note to say thank you for your time yesterday. The walk-through of the process was exactly what we needed, and the team left with a lot of clear next steps.

Best regards,
{{senderFirstName}}`,
      `You're welcome, I enjoyed it. Tell the team to come back with questions once they've tried it for a couple of weeks.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Moving our meeting',
    messages: [
      `Hi {{recipientFirstName}}, something came up on Thursday and I need to move our meeting. Could we do Friday morning instead? Same time is fine for me.`,
      `Friday morning works. See you then.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Reference for a former colleague',
    messages: [
      `Hi {{recipientFirstName}},

I hope you're doing well. A former colleague of yours has applied for a position with us and gave your name as a reference. Would you have ten minutes this week to talk about her work? It would help us a lot.

Kind regards,
{{senderFirstName}} {{senderLastName}}`,
      `Hello {{recipientFirstName}},

Of course, happy to help. I worked with her for about four years. Thursday afternoon is the best moment for me, anything between 14:00 and 16:00.

Regards,
{{senderFirstName}}`,
      `Thursday at 15:00 is perfect. I'll call you then. Thank you for making the time.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Timing of the contract review',
    messages: [
      `Hi {{recipientFirstName}},

Do you know when legal expects to finish reviewing the service agreement? We'd like to start on the first of next month, and our own team needs about a week after signing to prepare.

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

I asked this morning. They said the review should be done by Wednesday, with a couple of small comments on the payment terms. I'll forward you the comments as soon as I have them.

{{senderFirstName}}`,
      `Great, thanks for chasing that. Small comments on payment terms are fine, we can usually settle those in one call.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Budget for the autumn event',
    messages: [
      `Hi {{recipientFirstName}},

Has the budget for the autumn event been approved yet? I need to confirm the venue by Friday, and they're holding the date for us until then.

Thanks,
{{senderFirstName}}`,
      `Approved this morning, with one condition: we stay under 8,000 in total. Go ahead and confirm the venue. I'll send you the final numbers on Thursday.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Delivery of the second pallet',
    messages: [
      `Hello {{recipientFirstName}},

The first pallet arrived on Tuesday, but the second one hasn't shown up and the tracking page hasn't changed for three days. Could you look into it?

Regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Sorry about that. I checked with the carrier and the second pallet was held back at their depot because of a labelling issue. They are fixing it now and expect delivery on Friday.

{{senderFirstName}}`,
      `Thanks for sorting it out so quickly. Friday is fine. Please send a message if the date moves again, we have a team waiting for the material.

Best,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Planning the training day',
    messages: [
      `Hi {{recipientFirstName}},

I'm putting together the schedule for the training day on the 12th. Would you rather have the practical session in the morning when people are fresh, or after lunch? I can go either way.

{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Morning, I think. After lunch half the room gets sleepy, and the practical part needs attention. Maybe keep the introduction short and start the exercises by 10:00.

Thanks,
{{senderFirstName}}`,
      `Good point. I'll open at 9:00, introduction until 9:45, exercises right after the break. I'll send the full schedule tomorrow.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Agenda for the quarterly review',
    messages: [
      `Hi {{recipientFirstName}},

Here's my proposal for the agenda of the quarterly review: results of the last quarter, open projects and their risks, staffing, and plans for the next three months. Anything you'd like to add?

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Looks good. I'd add a short item on the supplier changes, since it affects the planning. Ten minutes should be enough.

{{senderFirstName}}`,
      `Added after staffing. Do you want to present it yourself, or should I?`,
      `I'll do it, I have the latest numbers. See you on Tuesday.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Connecting you with a colleague',
    messages: [
      `Hi {{recipientFirstName}},

You mentioned you were looking for someone who knows the logistics side of the Nordic market. A colleague of mine spent six years on exactly that. Would you like me to put the two of you in touch?

{{senderFirstName}}`,
      `Yes please, that would be very useful. Tell her I'm flexible on timing and happy to adapt to her schedule.

Thanks a lot,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Notes from this morning',
    messages: [
      `Hi {{recipientFirstName}},

Here are my notes from this morning's meeting. We agreed that you take the customer list, I take the schedule, and we meet again on Monday. Please tell me if I missed anything.

{{senderFirstName}}`,
      `That matches my notes. One addition: we also agreed to keep the kickoff to one hour. Otherwise all good.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Handover while I am away',
    messages: [
      `Hi {{recipientFirstName}},

I'm on leave from the 3rd until the 17th. While I'm gone, my colleague will cover the account and she knows the open items. The only thing in progress is the renewal paperwork, which should arrive next week.

Best,
{{senderFirstName}}`,
      `Thanks for letting me know, and enjoy your time off. Is there anything I should send you before you leave, or can it wait until you're back?

{{senderFirstName}}`,
      `It can wait. If something is time-sensitive, just send it to my colleague and she'll handle it.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'The numbers in the monthly report',
    messages: [
      `Hello {{recipientFirstName}},

I'm looking at the monthly report and the total for the northern region looks low compared with last month, about 12 percent down. Is that real, or is some data missing?

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Good question. Part of it is real, two large orders slipped into next month. But you're right that something is off. One of the smaller shops was not included in the export. I'll rerun it and send you a corrected report.

{{senderFirstName}}`,
      `Thanks. If the corrected total is still down, let's look at the two orders together.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Review of the website text',
    messages: [
      `Hi {{recipientFirstName}},

I've rewritten the text for our About page and the services page. Could you read it with fresh eyes? I mostly want to know if it sounds like us.

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

I read both. The services page is clear. The About page is a bit long, and the second paragraph repeats the first. If you cut that, I think it works. Also, I'd keep the sentence about the founding year, people like that.

Cheers,
{{senderFirstName}}`,
      `Agreed on the repeat, I'll cut it. Thanks for the quick read.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Logo files',
    messages: [
      `Hi {{recipientFirstName}}, could you send me your logo in vector format? We're printing the conference programme on Friday and I'd like to place it properly this time.`,
      `Of course. I'll ask our design team for the vector version and the one-colour version, and send both before the end of the day.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Planning your visit',
    messages: [
      `Hi {{recipientFirstName}},

We're looking forward to welcoming you and your team in two weeks. To plan the day, could you tell me how many people are coming and whether you'd like a tour of the production floor?

Kind regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Six people so far, possibly seven. And yes, a tour would be great, especially the packaging line. We'd also like an hour at the end for a general discussion.

Thanks,
{{senderFirstName}}`,
      `Perfect. I'll plan the tour for 10:30, lunch at 12:30 and the discussion at 13:30. Would you like me to book a table for dinner as well, or will you travel back in the afternoon?`,
      `Dinner would be nice, but several of us have a late train. I'll confirm the travel times tomorrow and then you can decide.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Invitation to join a panel',
    messages: [
      `Hi {{recipientFirstName}},

We're organising an industry afternoon in November and I thought of you for the panel on supply chain resilience. It would be about 40 minutes, with three other speakers, and a moderator who sends the questions in advance. Would you be interested?

Best regards,
{{senderFirstName}} {{senderLastName}}`,
      `Hi {{recipientFirstName}},

Thank you for thinking of me, I'd like to. Which date is it exactly? I have a trip planned in the first week of November.

{{senderFirstName}}`,
      `It's the 19th, from 14:00. I hope that doesn't clash with your trip. I'll send the details and the first set of questions as soon as you confirm.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Looking for an accountant',
    messages: [
      `Hi {{recipientFirstName}}, do you know a good accountant for a small business? Ours is retiring at the end of the year and I'd like to start looking early.`,
      `I do. The one we use is careful and answers quickly, and she works with a lot of companies of our size. I'll send you her details this afternoon. Tell her I recommended her.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Planning workshop',
    messages: [
      `Hi {{recipientFirstName}},

I'd like to organise a half-day workshop to plan next year with the three team leads. Would you be willing to facilitate? You have more experience with this format than anyone else here.

Thanks,
{{senderFirstName}}`,
      `Happy to. I'd suggest a Wednesday, with the whole morning blocked and no laptops. Can you send me last year's plan and the list of open topics a few days before?

{{senderFirstName}}`,
      `Sounds good. I'll book the big meeting room for the second Wednesday of next month and send you the material in advance.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'First week for the new colleague',
    messages: [
      `Hi {{recipientFirstName}},

Our new colleague starts on Monday and I'd like to make the first week easy for her. Would you have half an hour on Tuesday to explain how the ordering process works? She'll be working with you a lot.

Thanks,
{{senderFirstName}}`,
      `Sure, Tuesday at 10:00 works. I'll also put together a short list of the people she should meet in the first week. It's always easier with names and faces.

{{senderFirstName}}`,
      `That's a great idea, thank you. I'll set up her accounts on Friday so everything is ready on Monday morning.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Laptop order for the new team',
    messages: [
      `Hello {{recipientFirstName}},

We need five laptops for the new team by the middle of next month. Could you tell me the current lead time for the model we ordered last time, and whether the price is still the same?

Regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Lead time is about three weeks at the moment, so ordering this week would be safe. The price went up slightly, I'll send you the new quote this afternoon.

{{senderFirstName}}`,
      `Thanks. Send me the quote and I'll get the approval done on my side. If it's a small increase there shouldn't be an issue.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Results of the customer survey',
    messages: [
      `Hi {{recipientFirstName}},

The results of the customer survey are in. Overall they look good, but the answers about delivery times are worse than last year. Do you have time on Wednesday to look at them together?

{{senderFirstName}}`,
      `Yes, Wednesday morning is fine. Send me the raw numbers beforehand and I'll check if the delays are concentrated in a few regions.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Coffee when you are in town',
    messages: [
      `Hi {{recipientFirstName}},

I heard you'll be in the city next month for the trade fair. If you have an hour to spare, I'd love to catch up over coffee. It's been a while since we talked properly, and I'd like to hear how the new project is going.

Best,
{{senderFirstName}}`,
      `That would be nice! I arrive on the Tuesday and have the morning open. Is there a place near the main station?

{{senderFirstName}}`,
      `There's a small place two minutes from the station entrance. I'll send you the name closer to the date. Tuesday at 9:30?`,
    ],
  },
  {
    subject: 'Delivery window for Thursday',
    messages: [
      `Hello {{recipientFirstName}},

Our truck will arrive at your site on Thursday between 8:00 and 12:00. Is there someone on site who can receive the goods, and which entrance should the driver use?

Regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Yes, our warehouse lead will be there from 7:30. The driver should use the gate on the north side, the main entrance is closed because of roadworks.

{{senderFirstName}}`,
      `Understood, I'll pass that on to the driver. Thanks for the clear instructions.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Slides for Thursday',
    messages: [
      `Hi {{recipientFirstName}}, are the slides for Thursday ready? If you can send them by tomorrow evening I'll put them in the common deck and check the layout.`,
      `Almost done. I'm just tidying up the last chart. You'll have them tomorrow before six.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Expense policy question',
    messages: [
      `Hi {{recipientFirstName}},

A quick question about the expense policy. If I book a train ticket for a client visit and the client then cancels, can I still claim the ticket, or does it need approval first?

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Yes, you can claim it. Just add a short note that the visit was cancelled and keep the receipt. If the amount is above 150 it needs your manager's approval, but a normal train ticket is below that.

{{senderFirstName}}`,
      `Clear, thank you. It's well below that, so I'll submit it today.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Translating the manual',
    messages: [
      `Hi {{recipientFirstName}},

We need the product manual translated into German and French before the spring. It's about 40 pages with a lot of technical terms. Is that something you could take on, and what would the turnaround be?

Kind regards,
{{senderFirstName}}`,
      `Hello {{recipientFirstName}},

Yes, I can do both languages, with a colleague handling the French. For 40 pages I'd need about three weeks. If you send me a glossary of your terms, the result will be more consistent.

Best regards,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Visit to the warehouse',
    messages: [
      `Hi {{recipientFirstName}},

I'd like to visit the warehouse sometime this month to see the new picking area. Which day is quietest for you?

{{senderFirstName}}`,
      `Tuesdays and Wednesdays are the calmest. The morning is best, before the afternoon shipments are prepared. Safety shoes are required on the floor, I can lend you a pair if you don't have any.

{{senderFirstName}}`,
      `Wednesday morning then, I'll bring my own shoes. Around nine?

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Desks and the office move',
    messages: [
      `Hi {{recipientFirstName}},

The move to the new floor is planned for the weekend of the 15th. Please clear your desk by Friday evening and label your boxes with your name and team. The movers will place everything at your new desk.

Thanks,
{{senderFirstName}}`,
      `Got it. Will the monitors be moved as well, or do we use the new ones?

{{senderFirstName}}`,
      `The new floor has new monitors at every desk. Just leave your old ones where they are, we'll collect them later.`,
    ],
  },
  {
    subject: 'Feedback after the interview',
    messages: [
      `Hello {{recipientFirstName}},

Thank you again for taking the time to meet us last week. I wanted to ask if you have any feedback on how the process went, and if there is anything we could have explained better.

Kind regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Thanks for asking. The process was well organised, and everyone I met was open and direct. The only thing I missed was a clearer picture of the team structure, but that was answered in the second conversation.

Best,
{{senderFirstName}}`,
      `That's useful, we'll add an overview of the team to the first meeting. Thank you for the honest answer.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Speaking slot at the industry day',
    messages: [
      `Hi {{recipientFirstName}},

We're putting together the programme for the industry day in March. Last year people liked your talk on warehouse planning. Would you be willing to give a shorter version, around 20 minutes?

Best regards,
{{senderFirstName}}`,
      `Thank you, I'd be glad to. Is there a theme for the day, or can I choose the focus myself? I'd like to talk about planning peaks this time.

{{senderFirstName}}`,
      `The theme is flexibility, so planning peaks fits very well. Send me a title and two sentences by the end of the month and I'll put you in the programme.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Extension for the proposal',
    messages: [
      `Hi {{recipientFirstName}},

I know the deadline for the proposal is Friday, but we're waiting on figures from two partners. Would it be possible to send our submission on Monday morning instead?

Thank you for considering it,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

That's fine. Monday at noon is the latest, because the committee meets in the afternoon. Please make sure the summary page is complete even if some figures are still rough.

{{senderFirstName}}`,
      `Understood. Monday at 10:00 at the latest, and the summary page will be complete.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: "Export of last year's records",
    messages: [
      `Hello {{recipientFirstName}},

For the audit I need an export of last year's customer records, sorted by region. Is this something you can pull from the system, or should I ask someone else?

Thanks,
{{senderFirstName}}`,
      `I can do that. Do you need all fields, or only name, region and total order value? The full export is a large file and hard to read.

{{senderFirstName}}`,
      `Just those three are fine. If it's easy, add the date of the last order too.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Clash in our calendars',
    messages: [
      `Hi {{recipientFirstName}}, I just noticed that our review on Wednesday overlaps with a client call I can't move. Could we start 45 minutes later, at 15:15?`,
      `15:15 is fine for me. I'll update the invitation.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Thanks for the introduction',
    messages: [
      `Hi {{recipientFirstName}},

I wanted to thank you for putting me in touch with your contact last week. We spoke for almost an hour and I already learned a lot. I owe you one.

Best,
{{senderFirstName}}`,
      `Glad it worked out. They're a good person to know. Let me know how it goes.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Team lunch next month',
    messages: [
      `Hi {{recipientFirstName}},

I'm organising a team lunch on the last Friday of the month to celebrate finishing the project. Are you able to join? We'd be about 14 people.

{{senderFirstName}}`,
      `Count me in. Is there a preference for the type of food? Some places nearby have a fixed menu for larger groups, which makes it easier.

{{senderFirstName}}`,
      `A fixed menu sounds easiest. I'll ask for a quote from the Italian place around the corner and send out a poll for the dietary needs.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Access to the shared folder',
    messages: [
      `Hi {{recipientFirstName}},

I can't open the shared folder with the project documents anymore. It says I don't have permission. Did something change?

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Yes, we restructured the folders on Monday and the permissions were reset. I've added you again, it should work now. Let me know if you still see an error.

{{senderFirstName}}`,
      `It works again, thank you. Sorry for the trouble.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Quick question about the specification',
    messages: [
      `Hi {{recipientFirstName}}, in section 4 of the specification the maximum load is listed as 80 kilos, but the drawing says 100. Which one is correct?`,
      `Good eye. The drawing is correct, 100 kilos. The text wasn't updated after the last revision. I'll fix the document today.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Kickoff of the pilot project',
    messages: [
      `Hi {{recipientFirstName}},

The pilot with the two stores in the south starts on the 6th. Before the kickoff I'd like to agree on how we measure success. What numbers matter most to you?

Best,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

For us it's the time from order to delivery and the number of returns. If both improve by ten percent over eight weeks, we'd consider rolling it out further.

{{senderFirstName}}`,
      `That's clear and measurable. I'll set up a weekly overview with those two numbers and share it every Monday. Shall we do a short call after the second week to see how it's going?`,
      `Good plan. A call after week two works. I'll block Friday of that week.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Renewing the service agreement',
    messages: [
      `Hello {{recipientFirstName}},

Our service agreement ends in two months. We've been happy with the way it's working and would like to continue, possibly with a longer term. Could you tell me what you'd propose for the renewal?

Kind regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Good to hear, we're happy too. I'd suggest a two-year term with the same service levels, and a yearly review of the price. I'll write it up and send it to you next week.

Best regards,
{{senderFirstName}}`,
      `That sounds reasonable. Please include the reporting we discussed earlier. I'll look at it as soon as it arrives.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Feedback on the packaging samples',
    messages: [
      `Hi {{recipientFirstName}},

The samples of the new packaging arrived this morning. The box itself looks great, but the corners feel a bit weak when I press them. How did it hold up in your own checks?

{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

We saw the same on one of the three samples. The supplier says the glue needs longer to set, and that the next batch will be stronger. I'd wait for that one before making a decision.

{{senderFirstName}}`,
      `Agreed. Please send the next batch when you have it. I'll keep the three samples here in case we want to compare.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Booking the workshop room',
    messages: [
      `Hello {{recipientFirstName}}, is the large workshop room available on the 22nd, from nine until four? We'd need it for a planning day with about 12 people.`,
      `Hi {{recipientFirstName}},

Yes, it's available that day. I've put your name on it. If you need a projector or extra chairs, tell me by Monday.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Question about the confidentiality agreement',
    messages: [
      `Hi {{recipientFirstName}},

Before we share the technical drawings, I wanted to check one point in the confidentiality agreement. Clause 6 says the obligation lasts five years. Is that from signing or from the end of the project?

Thanks,
{{senderFirstName}}`,
      `Good question. It's five years from the end of the project. I'll ask our legal team to make that explicit in the wording so there's no doubt.

{{senderFirstName}}`,
      `That's what I expected, thank you. Once the wording is clear we can sign and exchange the drawings the same day.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Would you be my mentor?',
    messages: [
      `Hi {{recipientFirstName}},

I've admired the way you built the customer team over the past years, and I'm about to take on my first management role. Would you be open to meeting once every month or two to share some advice? I'd understand completely if your schedule doesn't allow it.

Kind regards,
{{senderFirstName}} {{senderLastName}}`,
      `Hi {{recipientFirstName}},

That's kind of you to say. I'd be happy to. Let's start with an hour next month and see if it's useful for both of us. Bring two or three situations you're struggling with, that's the best way to begin.

Best,
{{senderFirstName}}`,
      `Thank you, I really appreciate it. I'll prepare a few situations and send you some dates.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Heads-up on a customer complaint',
    messages: [
      `Hi {{recipientFirstName}},

A heads-up: one of our larger customers called this morning about a delayed order, and they were not happy. I've promised them an update by the end of the day. Can you tell me where their shipment is?

{{senderFirstName}}`,
      `Checking now. It left our warehouse on Monday and should have arrived yesterday. I'll call the carrier and come back to you within the hour.

{{senderFirstName}}`,
      `Thank you. If it turns out to be lost, let me know right away so we can send a replacement.`,
    ],
  },
  {
    subject: 'Lunch next week?',
    messages: [
      `Hi {{recipientFirstName}}, are you around next week? It would be good to have lunch and talk about how the year has gone so far.`,
      `I am, Wednesday or Thursday would suit me. The new sandwich place near the office is supposed to be good.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Travel for the offsite',
    messages: [
      `Hi {{recipientFirstName}},

For the offsite on the 9th and 10th, I'm arranging the travel. Would you prefer to take the train together with the rest of the team, or make your own way there?

Thanks,
{{senderFirstName}}`,
      `The train is fine. Which one are you booking?

{{senderFirstName}}`,
      `The 8:12 from the central station, arriving a little before eleven. The return is on the 10th at 17:40.`,
      `That works. I'll be at the station by 8:00.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Photos from the event',
    messages: [
      `Hi {{recipientFirstName}},

The photographer sent the pictures from last week's event. There are some really good ones of your team at the opening. Shall I put them in a shared album so you can pick the ones you want?

Best,
{{senderFirstName}}`,
      `Yes please, that would be great. Thanks for arranging all this, the event went really smoothly.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Reconciling the third quarter',
    messages: [
      `Hello {{recipientFirstName}},

While closing the third quarter I found a difference of about 2,300 between our records and your statement. It seems to come from two payments in the last week of September. Can you check on your side?

Regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

I looked at it. One payment was booked on the 30th on our side but arrived on the 2nd, which explains part of it. I'm still checking the second one.

{{senderFirstName}}`,
      `Thanks. If the first one explains about 1,800, the rest is small enough to follow up next week.`,
      `It is 1,850, so the remainder is 450. I found the second payment, it was split in two transfers. I'll send you a short overview so you can match everything.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Sorry for the late reply',
    messages: [
      `Hi {{recipientFirstName}},

Sorry for the late reply, the last two weeks were hectic. I read your suggestion and I think it's a good direction. Can we talk about it on Monday?

{{senderFirstName}}`,
      `No worries at all. Monday works, anytime after 11:00.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'New time for the stand-up',
    messages: [
      `Hi {{recipientFirstName}}, since the new colleagues join from another city, I'd like to move the daily stand-up from 9:00 to 9:30. Does that work for you?`,
      `That's fine with me, it gives me time to drop off the kids first. Thanks for asking.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Printer on the second floor',
    messages: [
      `Hi {{recipientFirstName}},

The printer on the second floor shows a paper jam, but I can't find any paper stuck. Do you know who looks after it?

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

The facility team does. I'll message them now. In the meantime the one on the third floor is working.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Mention in the local paper',
    messages: [
      `Hi {{recipientFirstName}},

A short heads-up: the local paper is writing a piece on companies that have started apprenticeship programmes, and they asked if they could mention ours. I said yes, and your name will probably appear as the contact. Is that all right?

Best,
{{senderFirstName}}`,
      `That's fine, glad to be mentioned. If they call me, I'll keep it short and speak about the programme. Thanks for letting me know first.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Back from the holidays',
    messages: [
      `Hi {{recipientFirstName}},

I hope you had a good break. I'm back at my desk and catching up. Is there anything from the last weeks that I should look at first?

{{senderFirstName}}`,
      `Welcome back! It was lovely, thanks. The most important thing is the supplier meeting on Thursday, the rest can wait a few days. I left a short summary in the shared notes.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Scheduling the stock count',
    messages: [
      `Hello {{recipientFirstName}},

We'd like to do the yearly stock count on the first weekend of December. Could you let me know how many people you can spare, and whether Saturday morning would work for your team?

Regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Saturday morning is fine, and I can provide four people. It would help if the counting sheets were ready the day before, so we can brief everyone beforehand.

{{senderFirstName}}`,
      `Four is plenty. I'll have the sheets printed by Thursday and send you the layout on Wednesday so you can check it.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Request for a price quote',
    messages: [
      `Hello {{recipientFirstName}},

We're planning to renovate our reception area next spring and I'm collecting quotes from a few companies. The room is about 40 square metres, and we'd like new flooring, lighting and a new counter. Could you tell me what you'd need to prepare a quote, and whether a visit is necessary?

Kind regards,
{{senderFirstName}} {{senderLastName}}`,
      `Hello {{recipientFirstName}},

Thanks for thinking of us. A visit would help, as we'd want to see the current floor and the electrical connections. I have time next Tuesday or Wednesday. After the visit I can send you a quote within a week.

Kind regards,
{{senderFirstName}}`,
      `Wednesday morning is fine. I'll make sure someone is at reception to let you in. The visit shouldn't take more than an hour, right?

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Open positions on the planning team',
    messages: [
      `Hi {{recipientFirstName}},

I'm looking for two planners for the winter season and I remember you mentioned a couple of people in your network who are looking for a change. Would you mind passing my details on?

Thanks a lot,
{{senderFirstName}}`,
      `Sure, I know two people who might be interested. I'll tell them to contact you directly. Do you have a rough idea of the start date?

{{senderFirstName}}`,
      `Ideally the beginning of November, but I'm flexible for the right people. Thank you for helping.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Catching up on the roadmap',
    messages: [
      `Hi {{recipientFirstName}},

Could we set up a short meeting to go over the roadmap for next quarter? A few of my team's plans depend on the dates in yours, and I want to avoid surprises.

{{senderFirstName}}`,
      `Good idea. I have a gap on Wednesday at 14:00 for 30 minutes. I'll bring the latest version of the planning.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Venue visit on Friday',
    messages: [
      `Hi {{recipientFirstName}},

I'm visiting the venue for the annual dinner on Friday at 11:00 and wondered if you'd like to join. It's easier to judge the layout in person, and you know better than I do how the guests move around.

{{senderFirstName}}`,
      `Friday at 11:00 works for me. Where do we meet, at the main entrance?

{{senderFirstName}}`,
      `Yes, at the main entrance. I'll be the one with the folder and a nervous look.`,
    ],
  },
  {
    subject: 'Checking in on the onboarding',
    messages: [
      `Hello {{recipientFirstName}},

It's been three weeks since your team started using the new system, and I wanted to ask how it's going. Are there parts that are unclear, or things you'd like us to explain again?

Best regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

Thanks for checking. It's going well overall. The only point that keeps coming up is how to correct an entry after it has been approved. A short explanation or a call with the team would be useful.

{{senderFirstName}}`,
      `Easy to arrange. I'll set up 30 minutes with your team next week and walk through it with real examples.

Best,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'A recipe for the potluck',
    messages: [
      `Hi {{recipientFirstName}}, everyone is bringing something for the potluck on Friday. Are you in? I'm thinking of making the lentil salad you liked last time.`,
      `I'm in, and I'd love that salad. I'll bring bread and something sweet. Let's make sure we don't end up with six desserts again.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Moving the delivery date',
    messages: [
      `Hello {{recipientFirstName}},

Our building work has been delayed and we can't receive the furniture on the 14th as planned. Would it be possible to deliver one week later, on the 21st?

Thanks for your understanding,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

That's possible. I've moved your order to the 21st. The driver will call you the day before to agree on a time slot.

{{senderFirstName}}`,
      `Thank you, that helps a lot. Someone will be on site all day.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Which version of the plan?',
    messages: [
      `Hi {{recipientFirstName}},

I have two versions of the project plan on my side, one dated the 3rd and one dated the 9th. Which one is current? I don't want to work from the wrong one.

Thanks,
{{senderFirstName}}`,
      `The one from the 9th is current. The earlier one still has the old end date. I'll remove it from the shared folder so it can't cause confusion again.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Contact person for the audit',
    messages: [
      `Hi {{recipientFirstName}},

The auditors will be with us the week of the 18th and asked for one contact person in your department. Would that be you, or should I ask someone else?

Best,
{{senderFirstName}}`,
      `That's me. They can contact me directly. I'll make sure the documents for last year are ready by the Friday before.

{{senderFirstName}}`,
      `Thank you. I'll give them your name today.`,
    ],
  },
  {
    subject: 'Joint presentation next month',
    messages: [
      `Hi {{recipientFirstName}},

I've been asked to present our joint results at the partner meeting next month, and I think it would be better if we did it together. You know the technical side much better than I do. Would you be up for splitting it, say ten minutes each?

Thanks,
{{senderFirstName}}`,
      `I'd like that. Ten minutes each is about right. Shall I take the technical part and you take the results and next steps?

{{senderFirstName}}`,
      `Perfect split. Let's find an hour next week to work out the order of the slides together.`,
      `How about Tuesday after lunch? I can come to your office if that's easier.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Following up on our conversation',
    messages: [
      `Hi {{recipientFirstName}},

Thank you for the conversation yesterday. To summarise what I understood: you'd like a monthly overview rather than a weekly one, and you'd like it sent to two people on your team. If I got any of this wrong, please tell me, otherwise I'll start with the next one on the first of the month.

Best regards,
{{senderFirstName}}`,
      `Your summary is correct. One small addition, please leave the regional breakdown at the bottom, my manager always asks about it. Thanks for being so flexible.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Holiday schedule for December',
    messages: [
      `Hello {{recipientFirstName}},

I'm making the holiday schedule for December and want to be sure the desk is covered over the last two weeks. Do you already know when you plan to take time off?

Thanks,
{{senderFirstName}}`,
      `I'd like to take the week of the 23rd. I'm happy to work the week before so there's coverage when it's busy. Does that fit?

{{senderFirstName}}`,
      `That fits well. I'll put you down for the 23rd and ask the others to fill in around it.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'A question about shipping to Belgium',
    messages: [
      `Hi {{recipientFirstName}},

A customer in Belgium asked whether we can ship the heavier items directly to their warehouse. I know you handle most of our international shipments. Is there a limit on weight or size for that route?

{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

For pallets up to 800 kilos there's no problem, and the transit time is about three days. For anything above that I need to arrange a special carrier, which takes longer and costs more. How heavy are the items?

{{senderFirstName}}`,
      `The heaviest is around 600 kilos, so we're within the limit. I'll tell the customer to expect delivery in about three days after dispatch. Thanks!

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'New employee badge',
    messages: [
      `Hi {{recipientFirstName}}, your badge for the new building is ready. You can collect it at reception, bring a photo ID. It will be activated for the main entrance and the second floor.`,
      `Thanks, I'll pick it up this afternoon. Does the badge also open the parking garage?

{{senderFirstName}}`,
      `Not yet, the garage needs a separate request. Send me your licence plate and I'll arrange it.`,
    ],
  },
  {
    subject: 'Thoughts on hiring a second analyst',
    messages: [
      `Hi {{recipientFirstName}},

With the growth of the team, I'm thinking about hiring a second analyst early next year. You've worked with a bigger team before. When did you feel it was the right moment? I don't want to hire too early, or too late.

Best,
{{senderFirstName}}`,
      `Good question. For me the sign was when the same person was the bottleneck for three things in a row, and when reports started going out later each month. If you see that, it's probably time. Hiring a bit early is cheaper than burning out your best person.

Cheers,
{{senderFirstName}}`,
      `That's a useful way to put it. We're already seeing the reports slip, so I'll start writing the job description this week. Thank you.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Room for the board meeting',
    messages: [
      `Hello {{recipientFirstName}}, could you reserve the boardroom for the 11th from 13:00 to 16:00? We expect eight people, and I'd like coffee and sandwiches at the start.`,
      `Reserved. I've ordered coffee and sandwiches for 12:45 so everything is ready when people arrive. Do you need the video screen as well?

{{senderFirstName}}`,
      `Yes please, two of the members will join remotely. Thank you for arranging it.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Seasonal staffing plan',
    messages: [
      `Hi {{recipientFirstName}},

I've drafted the staffing plan for the busy weeks before the holidays. Could you look at the shifts for your team? I tried to keep them balanced but I may have missed some constraints.

Thanks,
{{senderFirstName}}`,
      `I looked at it. Two things: two of my planners have school events on the 12th, so they shouldn't both be on the late shift, and the weekend shifts seem a bit heavy for the first week. Otherwise it's solid.

{{senderFirstName}}`,
      `I'll swap those and spread the weekend shifts more evenly. I'll send the new version tomorrow morning.`,
    ],
  },
  {
    subject: 'Quarter-end timing',
    messages: [
      `Hi {{recipientFirstName}}, since the quarter ends on Friday, please send me any remaining invoices by Thursday noon. After that I can't promise they will be booked in this period.`,
      `Understood. I have three left and will send them tomorrow morning.

{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Dates for the site visit',
    messages: [
      `Hello {{recipientFirstName}},

We'd like to schedule the site visit with your engineer before the end of the month. Our team is available on the 16th, the 20th or the 27th. Do any of these suit you?

Regards,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

The 20th is best for us. Our engineer can be there at 9:00. Please bring the latest drawings, and I'll make sure the site manager is present.

{{senderFirstName}}`,
      `The 20th at 9:00 is booked. We'll bring the drawings and two people from our team.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Layout of the annual report',
    messages: [
      `Hi {{recipientFirstName}},

I've gone through the first layout of the annual report. The cover and the opening page are great. On pages 6 and 7 the charts are hard to read, the labels are very small. Could they be bigger?

{{senderFirstName}}`,
      `Good point, I'll enlarge them and simplify the colours. I'll also move the text next to them so there's more space. New version tomorrow.

Thanks,
{{senderFirstName}}`,
    ],
  },
  {
    subject: 'Open questions before we start',
    messages: [
      `Hi {{recipientFirstName}},

Before we begin on Monday I'd like to confirm three things. Who is the main contact on your side? Which days are you on site? And is there a particular area you'd like us to start with?

Thanks,
{{senderFirstName}}`,
      `Hi {{recipientFirstName}},

I'm the main contact, with my colleague as backup. We're on site Monday to Thursday. Please start with the east wing, it has the tightest deadline.

{{senderFirstName}}`,
      `Clear. East wing first, and I'll check in with you each morning at 8:30 for the first week.

{{senderFirstName}}`,
    ],
  },
];

function padded(index: number): string {
  return String(index + 1).padStart(3, '0');
}

/** The built-in English corpus, ids "builtin-001" onwards. */
export const BUILTIN_CORPUS: readonly CorpusThread[] = DRAFTS.map((draft, index) => ({
  id: `builtin-${padded(index)}`,
  subject: draft.subject,
  messages: draft.messages.map((body, position) => ({
    author: position % 2 === 0 ? ('starter' as const) : ('responder' as const),
    body: body.trim(),
  })),
}));
