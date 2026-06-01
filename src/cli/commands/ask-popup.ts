import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSafe } from '../../shared/exec.js';
import { shellQuote } from '../../shared/shell.js';

/** Where the user chose to route an ask from the triage popup. */
export type AskTriageChoice = 'dismiss' | 'dashboard' | 'agent';

const POPUP_WIDTH = 46;
const INNER_WIDTH = POPUP_WIDTH - 6; // 2 border + 2 padding each side
const POPUP_TIMEOUT = 10; // seconds → auto-dismiss
// Fixed amber accent — deliberately distinct from the companion popup, whose
// border color tracks mood. A double border + amber reads as "an ask needs you".
const ACCENT_COLOR = 'colour214';

export interface AskTriageOpts {
  askId: string;
  /** Session name or short id, shown in the title bar. */
  sessionLabel: string;
  /** Ask title, shown in the body. */
  title: string;
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/** True if at least one tmux client is attached (so a popup can be displayed). */
export function hasAttachedClient(): boolean {
  const out = execSafe('tmux list-clients -F "#{client_name}"');
  return !!out && out.split('\n').filter(Boolean).length > 0;
}

/**
 * Show a triage popup for a newly-created ask and return where the user chose to
 * answer it. Modeled on the companion popup (`src/daemon/companion-popup.ts`) but
 * a dedicated 3-option chooser with collision-safe temp paths and a distinct
 * border. Returns 'dismiss' on timeout, no attached client, or any failure — the
 * ask is always still in the dashboard inbox, so this is purely a UX nicety.
 */
export function showAskTriagePopup(opts: AskTriageOpts): AskTriageChoice {
  const scriptPath = join(tmpdir(), `sisyphus-ask-${opts.askId}.sh`);
  const resultPath = join(tmpdir(), `sisyphus-ask-${opts.askId}.result`);

  try {
    const safeTitle = opts.title.trim().length > 0 ? opts.title : 'Question pending';
    const titleLines = wrapText(safeTitle, INNER_WIDTH);
    const bodyLines = [
      '',
      ...titleLines.map(l => `  ${l}`),
      '',
      '  [1] Dismiss',
      '  [2] Open in dashboard',
      '  [3] Open in agent',
      '',
      `  (auto-dismiss in ${POPUP_TIMEOUT}s)`,
      '',
    ];
    const content = bodyLines.join('\n') + '\n';
    const height = bodyLines.length + 2; // + top/bottom border

    const script = `#!/bin/sh
printf '\\033[?25l'
stty -echo 2>/dev/null
RESULT_FILE=${shellQuote(resultPath)}
printf '\\033[2J\\033[H'
cat <<'__SISYPHUS_ASK_EOF__'
${content}__SISYPHUS_ASK_EOF__
while IFS= read -r -n1 -t ${POPUP_TIMEOUT} k; do
  case "$k" in
    1|d|D|q|Q|'') printf 'dismiss' > "$RESULT_FILE"; break ;;
    2|b|B) printf 'dashboard' > "$RESULT_FILE"; break ;;
    3|a|A) printf 'agent' > "$RESULT_FILE"; break ;;
  esac
done
if [ ! -f "$RESULT_FILE" ]; then printf 'dismiss' > "$RESULT_FILE"; fi
`;
    writeFileSync(scriptPath, script, { mode: 0o755 });

    try { unlinkSync(resultPath); } catch { /* ignore */ }

    const popupTitle = ` ⚑ ${opts.sessionLabel} `;
    const clientsRaw = execSafe('tmux list-clients -F "#{client_name} #{client_width}"');
    if (!clientsRaw) return 'dismiss';
    const lines = clientsRaw.split('\n').filter(Boolean);
    if (lines.length === 0) return 'dismiss';

    let raw: string | null = null;
    for (const line of lines) {
      const lastSpace = line.lastIndexOf(' ');
      const client = line.slice(0, lastSpace);
      const clientWidth = parseInt(line.slice(lastSpace + 1), 10);
      if (!clientWidth) continue;
      const x = Math.max(0, clientWidth - POPUP_WIDTH - 1); // 1-cell right margin
      const args = [
        `-c ${shellQuote(client)}`,
        '-E -b double',
        `-T ${shellQuote(popupTitle)}`,
        `-S "fg=${ACCENT_COLOR}"`,
        `-s "fg=${ACCENT_COLOR}"`,
        `-x ${x} -y 2`,
        `-w ${POPUP_WIDTH} -h ${height}`,
        shellQuote(scriptPath),
      ].join(' ');
      execSafe(`tmux display-popup ${args}`);
      try { raw = readFileSync(resultPath, 'utf8').trim(); } catch { raw = null; }
      if (raw) break; // first client to answer wins
    }

    if (raw === 'dashboard') return 'dashboard';
    if (raw === 'agent') return 'agent';
    return 'dismiss';
  } catch {
    return 'dismiss';
  } finally {
    try { unlinkSync(resultPath); } catch { /* ignore */ }
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}
