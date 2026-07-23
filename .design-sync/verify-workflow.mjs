export const meta = {
  name: 'design-sync-verify-ui',
  description: 'Fan out per-component preview verification for @weldsuite/ui against the reference Storybook (scoped compare + grade + fix, ≤4 concurrent chromium)',
  phases: [
    { title: 'Verify', detail: 'each agent: scoped compare → grade from images → fix mismatches → record grades + learnings' },
  ],
}

// args = { batches: string[][], paths: {out, sbRef, nm, pkg, repoRoot} }
// Tolerate args arriving as a JSON string (the tool may stringify it).
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const { batches, paths } = A
const { out, sbRef, nm, pkg, repoRoot } = paths

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['components', 'generalLearnings'],
  properties: {
    components: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'verdict'],
        properties: {
          name: { type: 'string' },
          verdict: { enum: ['match', 'close', 'mismatch', 'blocked'] },
          note: { type: 'string' },
        },
      },
    },
    generalLearnings: {
      type: 'array',
      items: { type: 'string' },
      description: '[GENERAL] cross-component / config-level root causes for the orchestrator to fold into NOTES.md + config',
    },
  },
}

function promptFor(batch, batchId) {
  return `Fix design-sync previews so they match the repo's own storybook render.
Repo: ${repoRoot}. Your components (yours alone): ${batch.join(', ')}.

Why this matters: this design system is being synced to claude.ai/design, where a
design agent builds real UIs from this exact compiled bundle. The storybook render
is the proof of how each component should look; a preview that matches it proves the
component arrived intact, one that doesn't means every design built with it is wrong
the same way.

FIRST, read .design-sync/NOTES.md in full — especially the "GRADING — read raw PNGs, not sheet thumbnails (CRITICAL)" section. The compare SHEET scales the storybook panel (tight crop) and preview panel (full ~900×700 page) independently, so preview components LOOK ~half-size — that is a FRAMING ARTIFACT, not a real size difference. ALWAYS judge from the raw/ PNGs (${out}/_screenshots/compare/raw/<…>__sb.png vs …__ds.png), never grade "too small/mismatch" off the sheet thumbnail.

Artifacts per component (read these first):
- ${out}/_screenshots/compare/<group>__<Name>.png — true storybook render (left) vs preview render (right), per story. Full-res originals in ${out}/_screenshots/compare/raw/ — THESE are the authority for size/fidelity.
- .design-sync/.cache/compare/<Name>.json — pairing facts + shot paths (no similarity scores — your eyes judge).
- Preview source: .design-sync/previews/<Name>.tsx when owned, else generated .design-sync/.cache/previews/<Name>.tsx. Your fixes go to .design-sync/previews/<Name>.tsx.
- ${out}/.stories-map.json — components→story ids; find each story's source via its id in ${sbRef}/index.json (importPath). Story source is the authority on intended props/composition.
- .ds-sync/storybook/SKILL.md §4 — grading rubric + fix decision tree.

First action, once for the whole batch: run
  node .ds-sync/storybook/compare.mjs --out ${out} --storybook-static ${sbRef} --components ${batch.join(',')}
One scoped run captures every missing sheet in your batch (one browser launch); already-graded unchanged components skip automatically.

Per component (max 3 iterations):
1. Read the sheet; judge the PRIMARY story FROM THE TWO IMAGES (raw PNGs when the sheet is too small) per the §4 sampling rule — exhaustively when the component has portals, theme/provider sensitivity, an owned preview, or any warning; diagnose failures via the decision tree.
2. To fix: copy .design-sync/.cache/previews/<Name>.tsx to .design-sync/previews/<Name>.tsx and DELETE its first-line "// @ds-preview generated …" marker. The @ds-stories/... imports work unchanged. Mirror the story's JSX; inline story-local fixture data.
3. node .ds-sync/lib/preview-rebuild.mjs --config .design-sync/config.json --node-modules ${nm} --out ${out} --components <Name>
4. node .ds-sync/storybook/compare.mjs --out ${out} --storybook-static ${sbRef} --components <Name>   (clears that component's old grade — intended)
5. Re-Read the fresh sheet and Write verdicts to .design-sync/.cache/compare/<Name>.grade.json:
   {"stories": {"<story>": {"verdict": "match|close|mismatch", "note": "…"}}}
   Siblings you trust under the §4 sampling rule get {"verdict":"match","basis":"sibling-trusted"} — same single Write, no extra image opens. Done when every story grades match. A close story is still a fix target — name the delta, try the knob; accept close only when an iteration didn't improve it or there's no actionable cause, and the note must say what's off AND what you tried. Blocked after 3 iterations → grade honestly + record the blocker, move on.

HARD RULES — violating these corrupts other agents' work:
- Edit ONLY .design-sync/previews/{your components}.tsx, your components' .design-sync/.cache/compare/*.grade.json, and .design-sync/learnings/${batchId}.md.
- NEVER edit .design-sync/config.json, .design-sync/NOTES.md, .ds-sync/, or any other component's files.
- NEVER run package-build.mjs or package-validate.mjs (they rewrite the shared bundle). preview-rebuild.mjs + compare.mjs scoped via --components are your ONLY build commands.
- NEVER write an image-judged grade for images you haven't Read this iteration. A sibling-trusted verdict must carry "basis":"sibling-trusted" and is allowed only when the image-judged primary story graded match and the component is warning-free.
- A story that doesn't render in storybook either (sb-error) needs cfg.overrides.<Name>.skip; [PORTAL?] needs cfg.overrides.<Name>.cardMode "single". Both are config edits you may NOT make — record them in your learnings file + final report; the orchestrator applies them. NEVER neutralize a story's open state in the .tsx to hide overlay bleed — that destroys the fidelity being verified.
- If the SAME root cause appears in 2+ of your components — or even once when config-level (provider/css/font/token/import resolution) — STOP on those: it's global. Write it to your learnings file prefixed [GENERAL], report it, do NOT work around it per-component (an owned preview for a global cause persists and shadows the corrected generated preview on every future build).

Learnings: append to .design-sync/learnings/${batchId}.md as you go — one bullet per discovery:
"<Component>: <symptom> → <root cause> → <fix>", prefixed [GENERAL] if it applies beyond that component.

Return: for each of your components {name, verdict (match|close|mismatch|blocked), note}; and generalLearnings = the verbatim [GENERAL] bullets (empty array if none).`
}

phase('Verify')
const WAVE = 4 // ≤4 concurrent chromium captures — machine-contention cap
const results = []
for (let i = 0; i < batches.length; i += WAVE) {
  const wave = batches.slice(i, i + WAVE)
  log(`Verify wave ${i / WAVE + 1}/${Math.ceil(batches.length / WAVE)}: ${wave.length} batch(es), ${wave.flat().length} components`)
  const waveResults = await parallel(
    wave.map((batch, j) => () =>
      agent(promptFor(batch, `batch${i + j}`), { label: `verify:batch${i + j} (${batch.length})`, phase: 'Verify', schema: SCHEMA }),
    ),
  )
  results.push(...waveResults.filter(Boolean))
}

const all = results.flatMap((r) => r.components ?? [])
const learnings = results.flatMap((r) => r.generalLearnings ?? [])
const tally = all.reduce((m, c) => ((m[c.verdict] = (m[c.verdict] ?? 0) + 1), m), {})
log(`Verify complete: ${all.length} graded — ${JSON.stringify(tally)}; ${learnings.length} [GENERAL] learning(s)`)
return { components: all, tally, generalLearnings: learnings }
