---
description: Report a sisyphus bug — files a GitHub issue with feedback + diagnostics
argument-hint: "[what went wrong]"
---

You are helping the user file a sisyphus bug report. First check the command's usage:

```bash
sis admin bug -h
```

The report becomes a **public GitHub issue** on the sisyphus repo, so the human must see and approve it before it is filed.

User-supplied description: $ARGUMENTS

Workflow:

1. **Get a useful description.** If the description above is empty or vague, ask the user: what did they do, what they expected, what actually happened. A reproducible report is worth far more than "X is broken". Don't pad it — their words plus the auto-collected diagnostics are enough.

2. **Preview, never blind-file.** Run `sis admin bug "<description>" --dry-run` (add `--logs` only if the bug is daemon/runtime-related and the user is OK sharing log lines, which may contain file paths). Show the user the assembled title + body.

3. **Confirm.** Get explicit approval. If they want edits, adjust the description or `--title` and re-preview.

4. **File it.** Re-run the exact same command **without** `--dry-run`. Report the issue URL it prints. If `gh` is unauthenticated it prints a prefilled URL instead — give that to the user to open.

Pipe long descriptions via stdin to avoid shell escaping: `… | sis admin bug --stdin --dry-run`.
