#!/usr/bin/env node
/**
 * Regenerate the dashboard's task data from the WeldSuite MCP.
 *
 * Usage:
 *   node .claude/workflows/scripts/regenerate-dashboard.mjs
 *   node .claude/workflows/scripts/regenerate-dashboard.mjs --user user_xxxx
 *   node .claude/workflows/scripts/regenerate-dashboard.mjs --dry-run
 *
 * How it works:
 *   1. Spawns `claude -p <prompt>` headlessly. The prompt asks Claude to call
 *      mcp__weldsuite__search_tasks across all open statuses and emit JSON
 *      between <DATA>...</DATA> markers.
 *   2. Parses the JSON.
 *   3. Merges with the curated bundles in ./bundle-config.mjs. Unbundled tasks
 *      become singleton PRs ordered by priority.
 *   4. Patches dashboard.html between /* DATA-START *\/ and /* DATA-END *\/.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUNDLES, MODULE_NAMES, GATE_KEYWORDS } from "./bundle-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = join(__dirname, "..", "dashboard.html");

// ---------- args ----------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const USER_ID =
  args[args.indexOf("--user") + 1] && args.includes("--user")
    ? args[args.indexOf("--user") + 1]
    : "user_3984pBydzNbnt1KVhOHY5fZYzqq"; // Gert

// ---------- prompt ----------
const PROMPT = `You are a data fetcher. Do NOT interview me. Do NOT write any code. Do NOT explain.

Task: call the mcp__weldsuite__search_tasks tool repeatedly to gather ALL open tasks for assigneeId="${USER_ID}".

You MUST call the tool with each of these status filters and combine the results (limit=50 each):
  - status: "todo"
  - status: "in_progress"
  - status: "in_review"
  - status: "backlog"
  - status: "testing"

If any status returns 50 results, refine with priority filters (critical/high/medium/low/none) and call again until you have every record.

After fetching, output ONLY the following block, nothing else. No prose, no markdown fences, no commentary before or after.

<DATA>
{
  "fetchedAt": "<ISO timestamp>",
  "userId": "${USER_ID}",
  "tasks": [
    { "id": "...", "title": "...", "status": "...", "priority": "...", "type": "...", "projectId": "..." }
  ]
}
</DATA>

Rules:
- "type" is one of: task | bug | feature | story | epic. If absent in MCP response, use "task".
- "priority" is one of: critical | high | medium | low | none.
- "status" is one of: todo | in_progress | in_review | testing | backlog | done | cancelled.
- Skip tasks with status "done" or "cancelled".
- Strip newlines from titles.
- Output VALID JSON. No trailing commas.`;

// ---------- runner ----------
async function fetchTasksViaClaude() {
  console.log("⟳ Spawning `claude -p` to fetch tasks via MCP…");
  console.log(`  (assignee: ${USER_ID})`);

  return new Promise((resolve, reject) => {
    // Use shell:true so PATH lookup works on Windows (claude.cmd) and POSIX (claude).
    const child = spawn("claude", ["-p", PROMPT], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      process.stdout.write(".");
    });
    child.stderr.on("data", (b) => (stderr += b.toString()));

    child.on("error", (err) =>
      reject(new Error(`Failed to spawn 'claude': ${err.message}. Is the CLI installed and on PATH?`)),
    );

    child.on("exit", (code) => {
      process.stdout.write("\n");
      if (code !== 0) {
        console.error("stderr:", stderr.slice(0, 2000));
        return reject(new Error(`claude exited with code ${code}`));
      }
      const m = stdout.match(/<DATA>\s*([\s\S]*?)\s*<\/DATA>/);
      if (!m) {
        console.error("stdout sample:", stdout.slice(-2000));
        return reject(new Error("No <DATA>...</DATA> block in claude output."));
      }
      try {
        resolve(JSON.parse(m[1]));
      } catch (e) {
        reject(new Error(`Invalid JSON in <DATA> block: ${e.message}`));
      }
    });
  });
}

// ---------- merge ----------
const PRIO_ORDER = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

function buildPRs(rawTasks) {
  const byId = new Map(rawTasks.map((t) => [t.id, t]));
  const used = new Set();
  const prs = [];

  // Bundles first, in BUNDLES order.
  for (const b of BUNDLES) {
    const tasks = b.taskIds
      .map((id) => byId.get(id))
      .filter(Boolean) // task might have been closed since the bundle was curated
      .map((t) => ({ id: t.id, title: t.title, prio: t.priority, project: t.projectId, type: t.type }));
    if (tasks.length === 0) continue;
    b.taskIds.forEach((id) => used.add(id));

    // Bundle priority = highest priority among its tasks.
    const bundlePrio = tasks.reduce(
      (best, t) => (PRIO_ORDER[t.prio] < PRIO_ORDER[best] ? t.prio : best),
      "none",
    );

    prs.push({
      title: b.title,
      hyp: b.hyp,
      specialist: b.specialist,
      flags: b.flags,
      prio: bundlePrio,
      tasks,
    });
  }

  // Singletons: every other task, ordered by priority.
  const singletons = rawTasks
    .filter((t) => !used.has(t.id))
    .sort((a, b) => {
      const pa = PRIO_ORDER[a.priority] ?? 9;
      const pb = PRIO_ORDER[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;
      // Bugs before features/tasks within same priority.
      const aBug = a.type === "bug" ? 0 : 1;
      const bBug = b.type === "bug" ? 0 : 1;
      return aBug - bBug;
    });

  for (const t of singletons) {
    const flags = [];
    if (GATE_KEYWORDS.some((re) => re.test(t.title))) flags.push("gate");
    prs.push({
      title: t.title.slice(0, 100),
      hyp: "",
      specialist: "",
      flags,
      prio: t.priority,
      tasks: [{ id: t.id, title: t.title, prio: t.priority, project: t.projectId, type: t.type }],
    });
  }

  // Add PR numbers.
  return prs.map((pr, i) => ({ n: i + 1, ...pr }));
}

// ---------- patch ----------
function formatDataBlock(prs) {
  const indent = (n) => " ".repeat(n);
  const moduleEntries = Object.entries(MODULE_NAMES)
    .map(([k, v]) => `${indent(4)}${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n");

  const prsCode = prs
    .map((pr) => {
      const tasksCode = pr.tasks
        .map(
          (t) =>
            `${indent(8)}{ id: ${JSON.stringify(t.id)}, title: ${JSON.stringify(
              t.title,
            )}, project: ${JSON.stringify(t.project)}, prio: ${JSON.stringify(
              t.prio,
            )}, type: ${JSON.stringify(t.type)} },`,
        )
        .join("\n");
      return `${indent(4)}{
${indent(6)}n: ${pr.n}, title: ${JSON.stringify(pr.title)}, prio: ${JSON.stringify(pr.prio)}, flags: ${JSON.stringify(pr.flags)},
${indent(6)}hyp: ${JSON.stringify(pr.hyp)},
${indent(6)}specialist: ${JSON.stringify(pr.specialist)},
${indent(6)}tasks: [
${tasksCode}
${indent(6)}],
${indent(4)}},`;
    })
    .join("\n");

  return `/* DATA-START */
const DATA = {
${indent(2)}modules: {
${moduleEntries}
${indent(2)}},
${indent(2)}prs: [
${prsCode}
${indent(2)}],
};
/* DATA-END */`;
}

async function patchDashboard(newBlock) {
  const html = await readFile(DASHBOARD_PATH, "utf8");
  const re = /\/\* DATA-START \*\/[\s\S]*?\/\* DATA-END \*\//;
  if (!re.test(html)) {
    throw new Error(
      "dashboard.html is missing the /* DATA-START */ … /* DATA-END */ markers. Did you edit them out by hand?",
    );
  }
  const next = html.replace(re, newBlock);
  if (DRY_RUN) {
    console.log("⚠  --dry-run: not writing. Preview of new block (first 1.5KB):\n");
    console.log(newBlock.slice(0, 1500));
    return;
  }
  await writeFile(DASHBOARD_PATH, next, "utf8");
  console.log(`✓ Wrote ${DASHBOARD_PATH}`);
}

// ---------- main ----------
(async () => {
  try {
    const data = await fetchTasksViaClaude();
    if (!Array.isArray(data?.tasks)) throw new Error("MCP response has no 'tasks' array");
    console.log(`✓ Fetched ${data.tasks.length} open tasks`);
    const prs = buildPRs(data.tasks);
    console.log(`✓ Built ${prs.length} PR cards (${BUNDLES.length} bundles + ${prs.length - BUNDLES.length} singletons)`);
    const block = formatDataBlock(prs);
    await patchDashboard(block);
    console.log("\nDone. Open .claude/workflows/dashboard.html to view.");
  } catch (e) {
    console.error("✗", e.message);
    process.exit(1);
  }
})();
