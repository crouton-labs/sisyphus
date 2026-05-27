import type { Command } from 'commander';
import { join, resolve, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { contextDir, sessionsDir } from '../../shared/paths.js';
import type { RequirementStatus } from '../../shared/requirements-types.js';
import { exitUsage } from '../errors.js';
import { emitJsonOk } from '../output.js';

// Keeps the JSON Schema enum in sync with the TS union.
const _statusCheck: RequirementStatus[] = ['draft', 'question', 'approved', 'rejected', 'deferred'];

function resolveContextArtifact(
  file: string | undefined,
  opts: { sessionId?: string; cwd?: string },
  filename: string,
  notFoundMessage: string,
): string {
  const cwd = opts.cwd || process.env.SISYPHUS_CWD || process.cwd();
  if (file) return resolve(file);

  const sessionId = opts.sessionId || process.env.SISYPHUS_SESSION_ID;
  if (sessionId) {
    const target = join(contextDir(cwd, sessionId), filename);
    if (!existsSync(target)) {
      exitUsage('file-not-found', `File not found: ${target}`, { received: target });
    }
    return target;
  }

  const dir = sessionsDir(cwd);
  if (existsSync(dir)) {
    const sessions = readdirSync(dir);
    for (const session of sessions.reverse()) {
      const candidate = join(dir, session, 'context', filename);
      if (existsSync(candidate)) return candidate;
    }
  }

  exitUsage('file-not-found', notFoundMessage, {
    next: 'sis session inspect requirements --session-id <id>  # target a specific session',
  });
}

export function registerReview(program: Command): void {
  program
    .command('requirements')
    .description('Export and inspect EARS requirements produced by `sisyphus:spec` (or compatible writers)')
    .argument('[file]', 'Path to requirements.json (auto-detected from session if omitted)')
    .option('--session-id <id>', 'Session ID to find requirements for')
    .option('--cwd <path>', 'Project directory')
    .option('--schema', 'Print the requirements.json schema and exit')
    .option('--annotated', 'Print the schema with writing guidance annotations and exit')
    .option('--export', 'Render requirements.json into requirements.md (no LLM tokens; overwrites existing requirements.md)')
    .option('--force', 'With --export: overwrite existing requirements.md even if hand-edited; existing file is moved to requirements.md.bak before overwrite')
    .addHelpText('after', `
session inspect requirements: export, validate, and inspect EARS requirements.

Input
  [file]              optional — path to requirements.json; auto-detected from session if omitted
  --session-id <id>   optional — session ID for auto-detection
  --cwd <path>        optional — project directory for auto-detection
  --schema            optional — emit the requirements.json JSON Schema and exit
  --annotated         optional — emit the annotated writing guide and exit
  --export            optional — render requirements.json to requirements.md and emit the output path
  --force             optional — with --export: overwrite even if hand-edited (backs up to .bak)

File resolution (first match wins)
  1. Positional [file] argument
  2. --session-id (or $SISYPHUS_SESSION_ID) → .sisyphus/sessions/<id>/context/requirements.json
  3. Most recent session with a requirements.json

Output (stdout, JSON)
  --export:    { ok, data: { path } }  — path is the absolute path of the written requirements.md
  --schema:    { ok, data: <schema object> }
  --annotated: { ok, data: { markdown } }  — markdown is the annotated guide body string
  on error:    { ok: false, error: { code, message } }

Effects
  --export: Writes requirements.md alongside the source requirements.json.
  --force: Backs up existing requirements.md to requirements.md.bak before overwriting.
  --schema, --annotated: None. Read-only.

Exit codes: 0 ok | 2 usage.`)
    .action(async (file, opts) => {
      if (opts.force && !opts.export) {
        exitUsage('invalid-flags', '--force requires --export', {
          next: 'sis session inspect requirements --export --force',
        });
      }
      if (opts.export && opts.schema) {
        exitUsage('invalid-flags', '--export cannot be combined with --schema');
      }
      if (opts.export && opts.annotated) {
        exitUsage('invalid-flags', '--export cannot be combined with --annotated');
      }
      if (opts.export) {
        const targetPath = resolveContextArtifact(
          file,
          opts,
          'requirements.json',
          'No requirements.json found. Provide a path or use --session-id.',
        );

        if (!existsSync(targetPath)) {
          exitUsage('file-not-found', `File not found: ${targetPath}`, { received: targetPath });
        }

        const parsed = JSON.parse(readFileSync(targetPath, 'utf-8')) as Record<string, unknown>;
        const rendered = renderRequirementsMarkdown(parsed);
        const outPath = join(dirname(targetPath), 'requirements.md');
        const tmpPath = outPath + '.tmp';

        if (existsSync(outPath)) {
          const existing = readFileSync(outPath, 'utf-8');
          if (existing !== rendered) {
            if (!opts.force) {
              exitUsage('conflict', `${outPath} has been hand-edited (differs from rendered output)`, {
                next: 'sis session inspect requirements --export --force  # backs up to requirements.md.bak',
              });
            }
            const bakPath = outPath + '.bak';
            renameSync(outPath, bakPath);
            process.stderr.write(`Note: Existing requirements.md backed up to ${bakPath}\n`);
          }
        }

        writeFileSync(tmpPath, rendered, 'utf-8');
        renameSync(tmpPath, outPath);
        emitJsonOk({ path: resolve(outPath) });
        return;
      }
      if (opts.schema) {
        emitJsonOk(REQUIREMENTS_SCHEMA as unknown as Record<string, unknown>);
        return;
      }
      if (opts.annotated) {
        emitJsonOk({ markdown: REQUIREMENTS_ANNOTATED });
        return;
      }
    });

}

// ── Requirements schema ──────────────────────────────────────────────

const REQUIREMENTS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: {
    requirementItem: {
      type: 'object',
      required: ['id', 'title', 'ears', 'criteria', 'status'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^REQ-\\d{3}$' },
        title: { type: 'string' },
        ears: {
          type: 'object',
          required: ['shall'],
          properties: {
            when: { type: 'string' },
            while: { type: 'string' },
            if: { type: 'string' },
            where: { type: 'string' },
            shall: { type: 'string' },
          },
          oneOf: [
            { required: ['when', 'shall'] },
            { required: ['while', 'shall'] },
            { required: ['if', 'shall'] },
            { required: ['where', 'shall'] },
          ],
        },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            required: ['text', 'checked'],
            properties: {
              text: { type: 'string' },
              checked: { type: 'boolean' },
            },
          },
        },
        status: { type: 'string', enum: _statusCheck },
        agentNotes: { type: 'string' },
        userNotes: { type: 'string' },
      },
    },
  },
  title: 'Sisyphus Requirements',
  description: 'EARS-format behavioral requirements',
  type: 'object',
  required: ['meta', 'groups'],
  properties: {
    meta: {
      type: 'object',
      required: ['lastModified'],
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        summary: { type: 'string' },
        version: { type: 'integer' },
        lastModified: { type: 'string', format: 'date-time' },
        draft: { type: 'integer', minimum: 1 },
        stage: { type: 'string', enum: ['stage-2-in-progress', 'stage-2-verdict-pending', 'writer-redispatch-pending', 'stage-2-done', 'stage-3-done'] },
        bounceIterations: { type: 'integer', minimum: 0 },
        openAskId: { type: 'string' },
        writerRedispatchIterations: { type: 'integer' },
      },
    },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'description', 'requirements'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9-]+$' },
          name: { type: 'string' },
          description: { type: 'string' },
          context: { type: 'string' },
          requirements: {
            type: 'array',
            items: { $ref: '#/$defs/requirementItem' },
          },
          safeAssumptions: {
            type: 'array',
            items: { $ref: '#/$defs/requirementItem' },
          },
        },
      },
    },
  },
};

const REQUIREMENTS_ANNOTATED = `# requirements.json — Annotated Writing Guide
#
# This is NOT valid JSON — it's a reference showing every field with
# inline guidance. Run \`sis session inspect requirements --schema\` for the raw
# JSON Schema.
#
# Safe assumptions must satisfy the same EARS shape requirements as
# regular requirements.
#
# ── BEHAVIORAL ONLY ──
# Each requirement describes what the system does at its boundary —
# what the user, caller, or tester observes. The design (already
# approved) is the technical contract; the plan phase (later) handles
# implementation breakdown. Do not write requirements that name files,
# functions, libraries, data structures, or algorithms.

{
  "meta": {
    "title": "Feature Name Requirements",
    //        ^ Human-readable title.

    "subtitle": "EARS Behavioral Spec",
    //           ^ Secondary label. Usually "EARS Behavioral Spec".

    "summary": "2-3 sentences: what is being built, who it's for, and the key constraint.",
    //          ^ Orients the reviewer before they see individual items.
    //            Lead with the user-facing outcome only. The implementation
    //            belongs in design.md (technical) and plan.md (steps).

    "version": 1,
    //          ^ Always 1.

    "lastModified": "2026-04-04T12:00:00Z",
    //               ^ ISO 8601 timestamp. Update on each save.

    "draft": 1
    //        ^ Increment on each revision cycle (1, 2, 3...).

    // ── Spec lead state-machine fields (do NOT write unless you are the spec lead) ──
    // "stage": "stage-2-in-progress" | "stage-2-verdict-pending" | "writer-redispatch-pending" | "stage-2-done" | "stage-3-done"
    // "bounceIterations": number — bounce-loop counter, never decrements
    // "openAskId": string — background ask id for active Stage 2 review deck
    // "writerRedispatchIterations": number — writer re-dispatch counter, never decrements
  },

  "groups": [
    // Each group is a thematic area (e.g., "Session Creation", "Error Recovery").
    // Aim for 3-7 groups. Present them in narrative order.
    {
      "id": "kebab-case-group-id",
      //      ^ Unique, stable across drafts. Use kebab-case.

      "name": "Group Display Name",
      //       ^ Short label shown as the group header.

      "description": "What this group covers — one sentence.",
      //              ^ Shown below the group name. Keep it scannable.

      "context": "Rich introduction paragraph for this group.\\n\\nInclude ASCII diagrams:\\n\\n  User ──► Action ──► Response\\n                         │\\n                   ┌─────┴─────┐\\n                   ▼           ▼\\n                Success     Failure",
      //          ^ Use ASCII diagrams for flows, state transitions, architecture.
      //            Newlines are literal \\n in JSON.

      "requirements": [
        {
          "id": "REQ-001",
          //      ^ Sequential within the file. REQ-001, REQ-002, etc.
          //        Unique across ALL groups, not just this one.

          "title": "Short requirement title",
          //        ^ One line.

          "ears": {
            // ── EARS pattern object ──
            // Exactly ONE condition key + "shall". Never a flat string.
            //
            // Pick the matching pattern:
            //   Event-driven:  { "when": "When [trigger]", "shall": "..." }
            //   State-driven:  { "while": "While [condition]", "shall": "..." }
            //   Unwanted:      { "if": "If [bad condition]", "shall": "..." }
            //   Optional:      { "where": "Where [feature flag]", "shall": "..." }

            "when": "When the user runs \`start\` with a task description",
            //       ^ Start with the EARS keyword: When/While/If/Where.

            "shall": "the system shall return a session ID and surface the orchestrator's first response"
            //        ^ Observable behavior — what the caller sees at the boundary.
            //          Not "spawn", "instantiate", "import", or any verb that
            //          requires reading code to verify.
          },

          "criteria": [
            // Acceptance criteria — checkable assertions.
            {
              "text": "Session ID is returned to the caller",
              //       ^ One testable statement per criterion.

              "checked": false
              //          ^ Always false when you write it.
            }
          ],

          "status": "draft",
          //         ^ Your control. Values:
          //           "draft"    — new or revised, needs review
          //           "question" — blocked on user input, won't proceed without answer
          //           "approved" — user approved
          //           "rejected" — user rejected
          //           "deferred" — postponed, skip for now
          //
          //         Approved items are skipped on re-entry.

          "agentNotes": "Context for the reviewer — why this requirement exists, caveats, trade-offs.",
          //             ^ Explain anything non-obvious. Link to code if relevant.

          "userNotes": ""
          //            ^ Leave empty. The user writes back to you here.
        }
      ],

      /*
       * safeAssumptions — items the writer is confident the user will accept without
       * discussion: defaults, conventions, and obviously-correct behaviors that follow
       * directly from the design.
       *
       * NOT safe assumptions: anything novel, anything the writer is uncertain about,
       * or anything that would change with a small design tweak.
       *
       * Field shape: identical to a requirements item — same id pattern (REQ-NNN), same
       * ears structure, same criteria, same agentNotes. Use agentNotes to briefly justify
       * why each item qualifies as safe.
       */
      "safeAssumptions": [
        {
          "id": "REQ-010",
          "title": "Default session timeout is 30 minutes",
          "ears": {
            "where": "Where no custom timeout is configured",
            "shall": "the system shall expire idle sessions after 30 minutes"
          },
          "criteria": [
            { "text": "Session expires after 30 minutes of inactivity", "checked": false }
          ],
          "status": "draft",
          "agentNotes": "Safe assumption: 30-minute idle timeout is a near-universal default and the design doc does not specify an alternative.",
          "userNotes": ""
        }
      ]
    }
  ]
}`;

// ── Requirements markdown renderer ───────────────────────────────────

function renderRequirementItem(out: string[], req: Record<string, unknown>): void {
  const item: string[] = [];

  item.push(`### ${req.id}: ${req.title}`);
  item.push('');
  item.push(`**Status:** ${req.status}`);
  item.push('');

  const ears = req.ears as Record<string, string> | undefined;
  if (ears) {
    const earsClauses: string[] = [];
    if (ears.when) earsClauses.push(ears.when);
    if (ears.while) earsClauses.push(ears.while);
    if (ears.if) earsClauses.push(ears.if);
    if (ears.where) earsClauses.push(ears.where);
    if (ears.shall) earsClauses.push(ears.shall);
    if (earsClauses.length > 0) {
      item.push(earsClauses.join(', '));
      item.push('');
    }
  }

  const criteria = req.criteria as Array<{ text: string; checked: boolean }> | undefined;
  if (criteria && criteria.length > 0) {
    item.push('**Acceptance Criteria:**');
    item.push('');
    for (const c of criteria) {
      item.push(`- [${c.checked ? 'x' : ' '}] ${c.text}`);
    }
    item.push('');
  }

  const agentNotes = req.agentNotes ? String(req.agentNotes).trim() : '';
  if (agentNotes) {
    item.push('**Agent Notes:**');
    item.push('');
    item.push(agentNotes);
    item.push('');
  }

  const userNotes = req.userNotes ? String(req.userNotes).trim() : '';
  if (userNotes) {
    item.push('**User Notes:**');
    item.push('');
    item.push(userNotes);
    item.push('');
  }

  while (item.length > 0 && item[item.length - 1] === '') item.pop();
  out.push(...item);
}

function renderRequirementsMarkdown(json: Record<string, unknown>): string {
  const meta = json.meta as Record<string, unknown>;
  const groups = json.groups as Array<Record<string, unknown>>;
  const out: string[] = [];

  const title = meta.title ? String(meta.title) : undefined;
  if (title) {
    out.push(`# ${title}`);
    out.push('');
  }
  if (meta.subtitle) {
    out.push(`*${meta.subtitle}*`);
    out.push('');
  }
  const draftParts: string[] = [];
  if (meta.draft) draftParts.push(`Draft ${meta.draft}`);
  if (meta.lastModified) draftParts.push(String(meta.lastModified));
  if (draftParts.length > 0) {
    out.push(draftParts.join(' — '));
    out.push('');
  }
  if (title || draftParts.length > 0) {
    out.push('---');
    out.push('');
  }
  if (meta.summary) {
    out.push(String(meta.summary));
    out.push('');
  }

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];

    if (gi > 0) {
      out.push('');
      out.push('');
    }

    out.push(`## ${group.name}`);
    out.push('');

    if (group.description) {
      out.push(String(group.description));
      out.push('');
    }

    if (group.context) {
      out.push(String(group.context));
      out.push('');
    }

    const requirements = group.requirements as Array<Record<string, unknown>>;
    for (let ri = 0; ri < requirements.length; ri++) {
      if (ri > 0) out.push('');
      renderRequirementItem(out, requirements[ri]);
    }

    const safeAssumptions = group.safeAssumptions as Array<Record<string, unknown>> | undefined;
    if (safeAssumptions && safeAssumptions.length > 0) {
      out.push('');
      out.push('### Safe Assumptions');
      out.push('');
      for (let si = 0; si < safeAssumptions.length; si++) {
        if (si > 0) out.push('');
        renderRequirementItem(out, safeAssumptions[si]);
      }
    }
  }

  return out.join('\n') + '\n';
}
