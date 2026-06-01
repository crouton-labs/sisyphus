import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getMoodFace, getMoodTmuxColor } from '../shared/companion-render.js';
import type { FeedbackRating } from '../shared/companion-types.js';
import { loadCompanion } from './companion.js';
import { loadConfig } from '../shared/config.js';
import { execSafe } from '../shared/exec.js';
import { shellQuote } from '../shared/shell.js';

const POPUP_WIDTH = 38;
const INNER_WIDTH = POPUP_WIDTH - 6; // 2 border + 2 padding each side
const POPUP_DURATION = 15;
const POPUP_TMP_PREFIX = join(tmpdir(), 'sisyphus-popup');
const POPUP_SCRIPT = join(tmpdir(), 'sisyphus-popup.sh');
const POPUP_RESULT_PREFIX = join(tmpdir(), 'sisyphus-popup-result');
const WHIP_ANIMATION_PATH = resolve(import.meta.dirname, '../templates/whip-animation.sh');
const WHIP_ANIMATION_ROWS = 12; // canvas height baked into whip-frames.json

export interface PopupPage {
  text: string;
  title?: string; // overrides default face title
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(' ');
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
  return lines;
}

/** Show a single commentary popup (convenience wrapper). */
export function showCommentaryPopup(text: string): { rating: FeedbackRating; comment?: string } | null {
  return showCommentaryPopupQueue([{ text }]);
}

/** Show one or more popup pages in sequence. Enter advances; last Enter closes. */
export function showCommentaryPopupQueue(pages: PopupPage[]): { rating: FeedbackRating; comment?: string } | null {
  if (pages.length === 0) return null;

  try {
    const config = loadConfig(process.cwd());
    if (config.companionPopup === false) return null;

    const companion = loadCompanion();
    const intensity = companion.debugMood?.scores[companion.mood] ?? 0;
    const face = getMoodFace(companion.mood, intensity);
    const moodColor = getMoodTmuxColor(companion.mood);
    const defaultTitle = ` (${face}) `;

    let maxContentHeight = 0;

    // Write each page's content file
    for (let i = 0; i < pages.length; i++) {
      const lines = wrapText(pages[i].text, INNER_WIDTH);
      const isLast = i === pages.length - 1;
      const hint = isLast ? '[0:ok 1:good 2:bad 3:whip]' : '[enter:next  0-3:rate]';
      const hintPad = Math.max(0, Math.floor((INNER_WIDTH - hint.length) / 2));
      const hintLine = ' '.repeat(hintPad + 2) + hint;
      const content = '\n\n' + lines.map(l => `  ${l}`).join('\n') + '\n\n' + hintLine + '\n';
      const contentLineCount = content.split('\n').length - 1; // trailing \n artifact
      const contentHeight = Math.max(contentLineCount + 2, 5);
      if (contentHeight > maxContentHeight) maxContentHeight = contentHeight;
      writeFileSync(`${POPUP_TMP_PREFIX}-${i}.txt`, content);
    }

    // Popup must fit the whip animation's 12-row canvas (+2 for border) since '3:whip' is always available.
    const whipAvailable = existsSync(WHIP_ANIMATION_PATH);
    if (whipAvailable && maxContentHeight < WHIP_ANIMATION_ROWS + 2) {
      maxContentHeight = WHIP_ANIMATION_ROWS + 2;
    }

    const initialTitle = pages[0].title ?? defaultTitle;

    const script = `#!/bin/sh
printf '\\033[?25l'
stty -echo 2>/dev/null
RESULT_FILE=${shellQuote(POPUP_RESULT_PREFIX)}
PAGE=0
TOTAL=${pages.length}

show_page() {
  printf '\\033[2J\\033[H'
  cat ${shellQuote(POPUP_TMP_PREFIX)}-$PAGE.txt
}

show_page
while IFS= read -r -n1 -t ${POPUP_DURATION} k; do
  case "$k" in
    0) printf 'neutral' > "$RESULT_FILE"; break ;;
    1) printf 'good' > "$RESULT_FILE"; break ;;
    2) printf 'bad' > "$RESULT_FILE"; break ;;
    3) printf 'whip' > "$RESULT_FILE"
       ${whipAvailable ? `bash ${shellQuote(WHIP_ANIMATION_PATH)}` : ':'}
       break ;;
    c|C)
      stty echo
      printf '\\033[2J\\033[H> '
      IFS= read -r -t 30 line
      printf 'comment:%s' "$line" > "$RESULT_FILE"
      break
      ;;
    '')
      PAGE=$((PAGE + 1))
      if [ $PAGE -ge $TOTAL ]; then
        printf 'neutral' > "$RESULT_FILE"
        break
      fi
      show_page
      ;;
  esac
done
if [ ! -f "$RESULT_FILE" ]; then
  printf 'neutral' > "$RESULT_FILE"
fi
`;
    writeFileSync(POPUP_SCRIPT, script, { mode: 0o755 });

    // Delete stale result file before running popups
    try { unlinkSync(POPUP_RESULT_PREFIX); } catch { /* ignore */ }

    // Daemon runs outside tmux — target each attached client
    const clientsRaw = execSafe('tmux list-clients -F "#{client_name} #{client_width}"');
    if (!clientsRaw) return null;
    for (const line of clientsRaw.split('\n').filter(Boolean)) {
      const lastSpace = line.lastIndexOf(' ');
      const client = line.slice(0, lastSpace);
      const clientWidth = parseInt(line.slice(lastSpace + 1), 10);
      if (!clientWidth) continue;
      const x = Math.max(0, clientWidth - POPUP_WIDTH - 1); // 1-cell right margin
      const args = [
        `-c ${shellQuote(client)}`,
        '-E -b rounded',
        `-T ${shellQuote(initialTitle)}`,
        `-S "fg=${moodColor}"`,
        `-s "fg=${moodColor}"`,
        `-x ${x} -y 2`,
        `-w ${POPUP_WIDTH} -h ${maxContentHeight}`,
        shellQuote(POPUP_SCRIPT),
      ].join(' ');
      execSafe(`tmux display-popup ${args}`);
    }

    // Read feedback written by the last client's popup
    let raw: string;
    try {
      raw = readFileSync(POPUP_RESULT_PREFIX, 'utf8').trim();
    } catch {
      return null;
    } finally {
      try { unlinkSync(POPUP_RESULT_PREFIX); } catch { /* ignore */ }
    }

    if (raw.startsWith('comment:')) {
      return { rating: 'comment', comment: raw.slice('comment:'.length) };
    }
    const validRatings: FeedbackRating[] = ['neutral', 'good', 'bad', 'whip'];
    const rating = validRatings.includes(raw as FeedbackRating) ? (raw as FeedbackRating) : 'neutral';
    return { rating };
  } catch { /* non-fatal */ }
  return null;
}
