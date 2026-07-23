// Curated PR bundles for the dashboard.
// Edit this file when you want to change how tasks group into PRs.
// Tasks NOT listed in any bundle become "singleton" PRs (1 task = 1 PR) in priority order.

export const MODULE_NAMES = {
  "proj_mltcvympgjpf3edo": "Platform",
  "proj_mltcu9vf29l8pz6m": "WeldCRM",
  "proj_mltcv056h1jjm1fk": "WeldMail",
  "proj_mn7ga6996igircmk": "WeldChat",
  "proj_mnrmd6a2232fc43i": "WeldMeet",
  "proj_mng54nah3k5oysrp": "Calendar/Booking",
  "proj_mltctx2khziheqt2": "WeldFlow",
  "proj_mltcvd867xnigips": "WeldHost",
  "proj_mltcuor4tidstwyl": "Helpdesk Widget",
  "proj_mltcwf5btcydxusl": "WeldDesk",
  "proj_mltcw73mlaziacdk": "WeldAgent",
  "proj_morpdin0gd0p2ymz": "Teams",
};

// Each bundle = one PR. Order here = order in the dashboard (top = next to ship).
// `taskIds` references task IDs that exist in WeldSuite. Missing IDs are silently skipped.
export const BUNDLES = [
  {
    title: "Avatar consistency bundle",
    hyp: "Root cause: avatar URL helper not used consistently — different surfaces build avatar URLs differently.",
    specialist: "frontend-platform",
    flags: ["bundle"],
    taskIds: [
      "task_mooflyhkrpm9fu2u", // WeldMail avatars wrong
      "task_mon1xkcxj4g1x83z", // Teammember panel
      "task_mp5wyw9tsy2ysszh", // WeldMeet preview
      "task_mng31kp54gekuw1f", // WeldFlow assignees
    ],
  },
  {
    title: "Realtime cache-invalidation bundle",
    hyp: "Root cause: client mutations don't trigger immediate React Query invalidations + sidebar counters poll instead of subscribing to @weldsuite/realtime.",
    specialist: "frontend-platform + backend-workers (realtime-worker review)",
    flags: ["bundle"],
    taskIds: [
      "task_mp2q1hz8md25hce2",
      "task_momy6w7owxs5hlph",
      "task_mp4jz339w5bjfr9w",
    ],
  },
  {
    title: "WeldMeet camera/video bundle",
    hyp: "Root cause: video track state not restored on toggle / route change / guest actions.",
    specialist: "weldmeet-meetings + frontend-platform",
    flags: ["bundle"],
    taskIds: [
      "task_mp5wxyqptmmkejfy",
      "task_mp4jp3l983ft2np4",
      "task_mp4jodml80ugs0fv",
      "task_mo8ifmze297ilpei",
    ],
  },
  {
    title: "Activity page bundle",
    hyp: "Backend join missing channel name + last-activity timestamp not propagated.",
    specialist: "backend-app-api + frontend-platform",
    flags: ["bundle"],
    taskIds: ["task_mp749neib2vtrurr", "task_mox1x0e7e6mnssnq"],
  },
  {
    title: "CRM panel header bundle",
    hyp: "Detail panel header logic isn't shared between contact types.",
    specialist: "weldcrm + frontend-platform",
    flags: ["bundle"],
    taskIds: ["task_mp5koomq8eqs43v3", "task_mp4edihu8ccquvv8", "task_movy7rmcpjchyd2s"],
  },
  {
    title: "Notifications system rebuild",
    hyp: "Needs new entity-event types + a unified notifications service. ⛔ Expect schema + entity-events gate.",
    specialist: "backend-app-api + weldagent-ai + frontend-platform",
    flags: ["bundle", "gate"],
    taskIds: ["task_moojfeetsi1gbcfu", "task_mp2qp8y55e8445ej", "task_mp08c3udi2cnmufn"],
  },
  {
    title: "Pipeline templates in CRM settings (already in progress!)",
    hyp: "Your `git status` shows uncommitted work for this. Finish/commit BEFORE picking anything else.",
    specialist: "database (approval) + backend-app-api + frontend-platform",
    flags: ["gate"],
    taskIds: ["task_movy7a7869chvvvz"],
  },
  {
    title: "Domain panel & WeldHost bundle",
    hyp: "Domain detail panel should reuse the customer detail panel component; WeldHost panels missing chat/comment integration.",
    specialist: "weldhost-domains + frontend-platform",
    flags: ["bundle"],
    taskIds: ["task_mon222tuairmba20", "task_molyrea42ctliwg4", "task_mord6pmhvoqo9pw4", "task_mossruy0lxp1o1cl"],
  },
  {
    title: "Calendar / booking bundle",
    hyp: "Mixed bag — calendar bugs and booking features. Triage may split into 2 PRs.",
    specialist: "weldmeet-meetings + frontend-platform",
    flags: ["bundle"],
    taskIds: [
      "task_molxcjzxoq9tvlvt",
      "task_movy6f1yab03uzfv",
      "task_mp5k7ztwz6zq0ske",
      "task_movy6890nr9nb6l2",
      "task_moevjee8m8hsunjc",
      "task_mnhmx9qo8c6fro3w",
      "task_movy6t2wbzwye4a7",
    ],
  },
  {
    title: "WeldChat structure",
    hyp: "Role-based channel ACLs + agent membership rules. ⛔ Schema + entity-events likely needed.",
    specialist: "database (approval) + backend-app-api + weldagent-ai",
    flags: ["bundle", "gate"],
    taskIds: ["task_mp2q40sxtkcc918q", "task_moq8vyybretnwpww", "task_mo7j5mrnl9qr47sc"],
  },
];

// Singleton heuristics — flag any task matching one of these patterns with `gate` automatically.
// Keeps the dashboard honest when new tasks come in without manual curation.
export const GATE_KEYWORDS = [
  /\bschema\b/i,
  /\bmigration\b/i,
  /pipeline templates/i,
  /role[\s-]?based/i,
  /breakout room/i,
  /entity[- ]event/i,
];
