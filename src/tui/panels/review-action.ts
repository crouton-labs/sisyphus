import { execSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { shellQuote } from '../../shared/shell.js';
import { EXEC_ENV } from '../../shared/exec.js';
import { formatTimeAgo, ansiColor, ansiDim, truncate } from '../lib/format.js';

export interface ReviewActionPanel {
  /** Render rows for the detail pane given current dimensions. */
  render(cols: number, rows: number): string[];
  /** Returns true if the panel consumed the key. */
  handleKey(input: string): boolean;
  /** Currently selected action: 'open' or 'submit'. */
  selectedAction: 'open' | 'submit';
}

export interface MountReviewPanelOpts {
  cwd: string;
  sessionId: string;
  askId: string;
  reviewFile: string;        // from readReview()
  blockedSince?: string;     // from InboxItem
  draftCommentCount: number; // read draft.json's comments.length, or 0 if absent
  onAfterAction: () => void; // called after open/submit returns so the dashboard re-polls inbox
}

export function mountReviewActionPanel(opts: MountReviewPanelOpts): ReviewActionPanel {
  let selectedAction: 'open' | 'submit' = 'open';

  function render(cols: number, _rows: number): string[] {
    const rows: string[] = [];

    // Row 0: file path — dirname truncated, basename always visible
    const fileBase = basename(opts.reviewFile);
    const fileDir = dirname(opts.reviewFile);
    const maxPathLen = Math.max(8, cols - 4);
    const pathDisplay = truncate(`${fileDir}/${fileBase}`, maxPathLen);
    rows.push(` ${ansiColor('◈', 'magenta')} ${pathDisplay}`);

    // Row 1: age + draft comment count
    const age = opts.blockedSince ? formatTimeAgo(opts.blockedSince) : 'unknown';
    const commentText = opts.draftCommentCount === 1
      ? '1 comment in draft'
      : `${opts.draftCommentCount} comments in draft`;
    rows.push(` ${ansiDim(age)} · ${ansiDim(commentText)}`);

    // Row 2: blank separator
    rows.push('');

    // Row 3: Open editor action
    const openChevron = selectedAction === 'open' ? '>' : ' ';
    const openLabel = selectedAction === 'open'
      ? `${openChevron} ${ansiColor('[Open editor]', 'magenta', true)}`
      : `${openChevron} [Open editor]`;
    rows.push(` ${openLabel}`);

    // Row 4: Submit action
    const submitChevron = selectedAction === 'submit' ? '>' : ' ';
    const submitLabel = selectedAction === 'submit'
      ? `${submitChevron} ${ansiColor('[Submit]', 'magenta', true)}`
      : `${submitChevron} [Submit]`;
    rows.push(` ${submitLabel}`);

    // Row 5: blank
    rows.push('');

    // Row 6: key hint
    rows.push(` ${ansiDim('j/k toggle · Enter invoke · Esc unmount')}`);

    return rows;
  }

  function invokeOpen(): void {
    // Open the review file in an editor inside a tmux popup.
    // Uses the running sis binary: process.argv[1]
    const sisBin = process.argv[1]!;
    const cmd = `${shellQuote(sisBin)} ask review-open ${shellQuote(opts.askId)} --session ${shellQuote(opts.sessionId)}`;
    execSync(
      `tmux display-popup -E -w 90% -h 90% -d ${shellQuote(opts.cwd)} ${shellQuote(cmd)}`,
      { stdio: 'inherit', env: EXEC_ENV },
    );
    opts.onAfterAction();
  }

  function invokeSubmit(): void {
    const sisBin = process.argv[1]!;
    execSync(
      `${shellQuote(sisBin)} ask review-submit ${shellQuote(opts.askId)} --session ${shellQuote(opts.sessionId)}`,
      { stdio: 'inherit', cwd: opts.cwd, env: EXEC_ENV },
    );
    opts.onAfterAction();
  }

  function handleKey(input: string): boolean {
    // j / down arrow → select 'submit'
    if (input === 'j' || input === '\x1b[B') {
      selectedAction = 'submit';
      return true;
    }
    // k / up arrow → select 'open'
    if (input === 'k' || input === '\x1b[A') {
      selectedAction = 'open';
      return true;
    }
    // Enter → invoke selected action
    if (input === '\r' || input === '\n') {
      if (selectedAction === 'open') {
        invokeOpen();
      } else {
        invokeSubmit();
      }
      return true;
    }
    // All other keys fall through (Esc handled by outer handler for unmount)
    return false;
  }

  return {
    render,
    handleKey,
    get selectedAction() { return selectedAction; },
  };
}
