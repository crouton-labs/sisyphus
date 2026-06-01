/**
 * sisyphus-validation-loop
 * ────────────────────────
 * A faithful map of Sisyphus's review/fix + validation machinery onto a
 * claude-workflow. This is a STRUCTURAL DEMONSTRATION — it is runnable in
 * principle, but the agentType names below (sisyphus:operator, etc.) are
 * daemon-spawned plugin agents that only exist inside a live session, so the
 * default workflow agent is used and the Sisyphus role is noted in the label
 * and comments. Swap in real agentTypes if you run this inside a session that
 * registers them.
 *
 * HOW SISYPHUS MAPS:
 *
 *   orchestrator (stateless, killed each cycle)   →  this script's control flow
 *   sis orch yield --mode <m>                      →  loop iteration / return verdict
 *   sisyphus:review (coordinator, one pass/stage)  →  the Review→Confirm pipeline
 *     └ reuse/quality/efficiency/... sub-reviewers →  pipeline stage 1 (dimensions)
 *     └ per-finding validation sub-agents          →  pipeline stage 2 (adversarial confirm)
 *   sisyphus:operator / CLI / API validators       →  parallel evidence agents
 *   "read the evidence critically"                 →  the Triage agent
 *   sisyphus:implement fix agents                  →  the Fix parallel fan-out
 *
 * TWO NESTED MECHANICS, faithfully preserved:
 *   1. REVIEW PASS — runs exactly ONCE on the implementation diff. Fan out
 *      dimension reviewers, adversarially confirm each finding, route confirmed
 *      ones to fix agents. There is deliberately NO re-review after fixes
 *      (orchestrator-impl.md:115 "One Review Pass Per Stage"). Regressions are
 *      caught by the validation loop below, not a second static scan.
 *   2. VALIDATION LOOP — the actual loop. Exercise the feature for real,
 *      gather evidence, triage it critically, and on bugs fix + RE-VALIDATE
 *      (not re-review). Exits on pass (completion), architectural flaw
 *      (replan — a human/planning decision, so we return rather than loop),
 *      or cycle exhaustion.
 */

export const meta = {
  name: 'sisyphus-validation-loop',
  description:
    "Sisyphus review/fix + validation cycle as a workflow: one adversarially-verified review pass, then a prove-it-works validation loop that fixes and re-validates (never re-reviews) until it passes, hits an architectural flaw, or exhausts its cycle budget.",
  phases: [
    { title: 'Review',           detail: 'one pass: parallel dimension sub-reviewers on the diff' },
    { title: 'Confirm',          detail: 'adversarially verify each finding; drop the unconfirmed' },
    { title: 'Fix (review)',     detail: 'route confirmed findings to fix agents, grouped by file' },
    { title: 'Validate',         detail: 'parallel evidence agents exercise the feature vs the e2e recipe' },
    { title: 'Triage',           detail: 'read evidence critically; classify pass / bugs / architectural' },
    { title: 'Fix (validation)', detail: 'fix the concrete validation failures, then re-validate' },
  ],
}

// ─── Inputs (all optional; pass via Workflow `args`) ──────────────────────────
const goal      = args?.goal      ?? 'goal.md — the implemented feature meets its success criteria'
const recipe    = args?.recipe    ?? 'context/e2e-recipe.md'
const diffScope = args?.diff      ?? 'git diff main...HEAD'
const MAX_CYCLES = args?.maxCycles ?? 3

// Review dimensions. Sisyphus scales this 3→16 sub-agents by diff size and adds
// security/compliance/tests by classification (review.md "Scaling Sub-agents").
// Here it's a flat list; extend via args.dimensions to mirror that scaling.
const DIMENSIONS = args?.dimensions ?? ['reuse', 'quality', 'efficiency']

// Validation surfaces. Sisyphus rule: if the feature touches ANYTHING
// user-facing, an operator is mandatory ("The Operator Is Not Optional").
// Each entry maps to a real Sisyphus agent via `sisAgent`.
const AREAS = args?.areas ?? [
  { key: 'ui',      sisAgent: 'sisyphus:operator',  hint: 'Drive the real UI in a browser: navigate, click, fill forms, screenshot.' },
  { key: 'backend', sisAgent: 'sisyphus:implement', hint: 'Exercise endpoints/CLI for real: curl with status codes, run the suite, tail logs.' },
]

// ─── Schemas — these mirror Sisyphus's on-disk contracts ──────────────────────

// What a validation agent returns. Mirrors the "What Counts as Proof" rule:
// every step needs concrete evidence, never "looks correct".
const EVIDENCE_SCHEMA = {
  type: 'object',
  required: ['area', 'steps'],
  properties: {
    area: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step', 'result', 'evidence'],
        properties: {
          step:     { type: 'string' },
          result:   { type: 'string', enum: ['pass', 'fail'] },
          evidence: { type: 'string', description: 'command output / screenshot path / HTTP status+body / log line. NOT "looks correct".' },
        },
      },
    },
  },
}

// The orchestrator's critical read of the evidence → one of three exit paths.
const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['outcome', 'summary', 'evidenceSupportsClaims'],
  properties: {
    outcome:                { type: 'string', enum: ['pass', 'bugs', 'architectural'] },
    summary:                { type: 'string' },
    evidenceSupportsClaims: { type: 'boolean', description: 'false if any pass-claim rests on thin/absent/contradictory evidence (e.g. a screenshot of an error state)' },
    goalCoverage:           { type: 'string', description: 'each goal.md clause naming user-visible behavior → the recipe step that exercised it (or GAP)' },
    failures: {
      type: 'array',
      description: 'concrete, evidence-backed failures to fix (only when outcome=bugs)',
      items: {
        type: 'object',
        required: ['file', 'description'],
        properties: {
          file:        { type: 'string' },
          description: { type: 'string' },
          evidence:    { type: 'string' },
        },
      },
    },
  },
}

// A review sub-reviewer's output. Mirrors the <finding> tags in review.md:125.
const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      description: 'empty array is a valid, common outcome — do not backfill',
      items: {
        type: 'object',
        required: ['severity', 'scope', 'location', 'evidence', 'impact'],
        properties: {
          severity: { type: 'string', enum: ['Critical', 'High', 'Medium'] },
          scope:    { type: 'string', enum: ['isolated', 'systemic'] },
          location: { type: 'string', description: 'file:line — for systemic, list every affected site' },
          evidence: { type: 'string' },
          impact:   { type: 'string' },
        },
      },
    },
  },
}

// The adversarial validation verdict. Mirrors review.md:78-82 + the four-gate
// "Flag only when" criteria (in-diff / needs-judgment / concrete / objective).
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reason'],
  properties: {
    isReal: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

// A fix agent's report.
const FIX_SCHEMA = {
  type: 'object',
  required: ['file', 'applied'],
  properties: {
    file:      { type: 'string' },
    applied:   { type: 'boolean' },
    skipped:   { type: 'string', description: 'items skipped as false-positive / needing a design decision, with why' },
    summary:   { type: 'string' },
    typecheck: { type: 'string', description: 'type-check / test result after the fix' },
  },
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

// Scope-only dispatch. review.md:23 — NEVER pass hypotheses or "look for X" to a
// sub-reviewer; that anchors it and kills independent findings. The dimension
// IS the scope; that's all we assign.
const reviewPrompt = (dim, diff) =>
  `Review this changeset on the "${dim}" dimension only. Changeset: \`${diff}\`. ` +
  `Read CLAUDE.md and any .claude/rules/*.md for conventions in the touched areas. ` +
  `Report each finding with concrete file:line evidence; no file:line → not a finding. ` +
  `A clean result ("no concerns") is valid and common — do not stretch to fill output. ` +
  `Report the class, not just the instance: if one flaw recurs, mark it systemic and enumerate every site.`

// Adversarial confirm. Try to REFUTE; survive only by passing all four gates.
const confirmPrompt = (f) =>
  `Adversarially verify this review finding — try to REFUTE it. Read the actual code first.\n` +
  `[${f.severity} / ${f.scope}] ${f.location}\nEvidence: ${f.evidence}\nClaimed impact: ${f.impact}\n\n` +
  `Return isReal=false UNLESS you can independently confirm ALL of: (1) it is in the current diff, ` +
  `(2) it needs human judgment a linter/typechecker wouldn't catch, (3) it has concrete file:line evidence, ` +
  `(4) it is objective (behavior/security/correctness, not style). Default to refuted when uncertain.`

const validatePrompt = (a, recipe, goal) =>
  `Validate the "${a.key}" surface against the e2e recipe at ${recipe}. ${a.hint}\n` +
  `Goal under test: ${goal}.\n` +
  `EXERCISE the feature for real — actually run it / drive it. Match depth to the runtime: ` +
  `a long-running process must be booted, a rendered surface must be driven, an integrated path ` +
  `must be exercised end-to-end (not each half in isolation). For EVERY recipe step capture concrete ` +
  `evidence (command output, screenshot path, HTTP status+body, log line). "Looks correct" / "should work" ` +
  `is NOT evidence. Return each step as pass/fail with its evidence.`

const triagePrompt = (evidence, goal, recipe) =>
  `You are the validation orchestrator. Read these validation reports CRITICALLY — verify the evidence ` +
  `actually supports each pass-claim. A screenshot of an error state is a FAIL. Thin or missing evidence ` +
  `behind a "pass" is a FAIL, not a pass.\n\nREPORTS:\n${JSON.stringify(evidence, null, 2)}\n\n` +
  `Goal: ${goal}\nRecipe: ${recipe}\n\nClassify the outcome:\n` +
  `• "pass" — every recipe step passed with real evidence AND every goal clause naming a user-visible ` +
  `behavior has a recipe step that exercised it (goal-coverage, not recipe-self-coverage).\n` +
  `• "bugs" — concrete failures fixable in implementation. Populate failures[] with file + description + evidence.\n` +
  `• "architectural" — the approach itself is wrong, not just bugs.`

const fixPrompt = (w) =>
  `Fix these issues, all in ${w.file}:\n` +
  w.items.map((it, i) => `${i + 1}. ${it}`).join('\n') +
  `\n\nImplement the fixes, then run type-check (and tests if present). Review your own changes with /simplify ` +
  `before reporting. If an item is a false positive or needs a design decision, SKIP it and say why — don't guess.`

// Route findings to where the fix lives, grouped by file so parallel fix agents
// own disjoint files (matches Sisyphus fix agents editing the live tree — no
// worktree isolation needed because file ownership is disjoint).
function routeFixes(items) {
  const byFile = {}
  for (const it of items) {
    const file = (it.file ?? it.location ?? 'unknown').split(':')[0].trim()
    const desc = it.description ?? `[${it.severity}/${it.scope}] ${it.evidence} → ${it.impact}`
    ;(byFile[file] ??= []).push(desc)
  }
  return Object.entries(byFile).map(([file, list]) => ({ file, items: list }))
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — THE REVIEW PASS (runs exactly once; no re-review afterward)
// ══════════════════════════════════════════════════════════════════════════════
// Canonical dimensions→find→verify pipeline: each dimension's findings are
// adversarially confirmed the moment that dimension finishes (no barrier — the
// `quality` reviewer's findings get verified while `efficiency` is still reading).
phase('Review')
log(`Review pass on \`${diffScope}\` across ${DIMENSIONS.length} dimensions: ${DIMENSIONS.join(', ')}`)

const reviewed = await pipeline(
  DIMENSIONS,
  // Stage 1 — one sub-reviewer per dimension. In Sisyphus these are the
  // `reuse`/`quality`/`efficiency`/... subagent_types under the review coordinator.
  (dim) => agent(reviewPrompt(dim, diffScope), {
    label: `review:${dim}`,
    phase: 'Review',
    schema: FINDINGS_SCHEMA,
  }),
  // Stage 2 — adversarially confirm each finding from THIS dimension.
  // Mirrors the review agent's validation sub-agents that filter noise.
  (review, dim) => parallel((review.findings ?? []).map((f) => () =>
    agent(confirmPrompt(f), {
      label: `confirm:${dim}:${f.location}`,
      phase: 'Confirm',
      schema: VERDICT_SCHEMA,
    }).then((v) => ({ ...f, dimension: dim, verdict: v }))
  )),
)

const confirmed = reviewed.flat().filter(Boolean).filter((f) => f.verdict?.isReal)
log(`Review: ${confirmed.length} findings survived adversarial validation`)

if (confirmed.length) {
  phase('Fix (review)')
  const slices = routeFixes(confirmed)
  await parallel(slices.map((w) => () =>
    agent(fixPrompt(w), { label: `fix:${w.file}`, phase: 'Fix (review)', schema: FIX_SCHEMA })
  ))
  log(`Fixed ${confirmed.length} findings across ${slices.length} files — NOT re-reviewing (regressions surface in validation)`)
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — THE VALIDATION LOOP (the actual loop: validate → triage → fix → re-validate)
// ══════════════════════════════════════════════════════════════════════════════
let cycle = 0
let verdict = null

while (cycle < MAX_CYCLES) {
  cycle++

  // Validate — fan out evidence agents per surface. BARRIER: triage needs every
  // report together to judge goal-coverage across the whole feature.
  phase('Validate')
  log(`Validation cycle ${cycle}/${MAX_CYCLES} — exercising ${AREAS.length} surfaces`)
  const evidence = (await parallel(AREAS.map((a) => () =>
    agent(validatePrompt(a, recipe, goal), {
      label: `validate:${a.key} (${a.sisAgent})`,
      phase: 'Validate',
      schema: EVIDENCE_SCHEMA,
      // In a live Sisyphus session this would be: agentType: a.sisAgent
    })
  ))).filter(Boolean)

  // Triage — the orchestrator's critical read of the evidence.
  phase('Triage')
  const triage = await agent(triagePrompt(evidence, goal, recipe), {
    label: `triage#${cycle}`,
    phase: 'Triage',
    schema: TRIAGE_SCHEMA,
  })
  log(`Cycle ${cycle} verdict: ${triage.outcome} — ${triage.summary}`)

  // → completion. Equivalent to: sis orch yield --mode completion
  if (triage.outcome === 'pass' && triage.evidenceSupportsClaims) {
    verdict = { status: 'completion', cycle, summary: triage.summary, goalCoverage: triage.goalCoverage }
    break
  }

  // → planning. Architectural flaws are a planning/human decision, not a fix
  // loop — so we return rather than spin. Equivalent to: sis orch yield --mode planning
  if (triage.outcome === 'architectural') {
    verdict = { status: 'replan', cycle, reason: triage.summary }
    break
  }

  // → bugs. Fix the concrete failures, then loop back to RE-VALIDATE (not re-review).
  // Equivalent to: sis orch yield --mode implementation, then back to validation.
  const failures = triage.failures ?? []
  if (!failures.length) {
    // Degenerate: outcome=bugs but nothing actionable, or a "pass" with thin evidence.
    verdict = { status: 'needs-human', cycle, reason: triage.summary, note: 'no actionable failures and not a clean pass' }
    break
  }

  phase('Fix (validation)')
  const slices = routeFixes(failures)
  await parallel(slices.map((w) => () =>
    agent(fixPrompt(w), { label: `fix:${w.file}`, phase: 'Fix (validation)', schema: FIX_SCHEMA })
  ))
  log(`Cycle ${cycle}: fixed ${failures.length} validation failures across ${slices.length} files — re-validating`)
}

if (!verdict) {
  verdict = { status: 'exhausted', cycle, note: `hit MAX_CYCLES=${MAX_CYCLES} without passing validation` }
}

return verdict
