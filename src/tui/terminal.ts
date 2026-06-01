export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

export type KeypressHandler = (input: string, key: Key) => void;

function emptyKey(): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
  };
}

// ── Terminal Setup/Teardown ──────────────────────────────────────────────────

export function setupTerminal(): () => void {
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
  // Safety net for the whole class of stray async work (fire-and-forget IIFEs,
  // unguarded `void someAsync()`): without this, Node ≥15 terminates on an
  // unhandled rejection and the alternate screen / cursor are never restored.
  // Individual call sites should still `.catch` to degrade gracefully — this
  // only guarantees the terminal is restored before we die.
  process.on('unhandledRejection', (reason) => {
    cleanup();
    console.error(reason);
    process.exit(1);
  });

  return cleanup;
}

// ── Stdout Write Helper ──────────────────────────────────────────────────────

export function writeToStdout(data: string): void {
  process.stdout.write(data);
}

// ── Keypress Parser ──────────────────────────────────────────────────────────

/**
 * Parse all complete key sequences from a buffer string.
 * Returns an array of [input, Key] pairs and the remaining unparsed buffer.
 */
function parseBuffer(buf: string): { events: Array<[string, Key]>; remaining: string } {
  const events: Array<[string, Key]> = [];

  let i = 0;
  while (i < buf.length) {
    const ch = buf[i]!;

    // ESC prefix sequences
    if (ch === '\x1b') {
      const rest = buf.slice(i + 1);

      // CSI sequences: \x1b[...
      if (rest.startsWith('[')) {
        const after = rest.slice(1);

        // Shift+Arrow: \x1b[1;2A/B/C/D
        const shiftArrow = after.match(/^1;2([ABCD])/);
        if (shiftArrow) {
          const key = emptyKey();
          key.shift = true;
          const dir = shiftArrow[1]!;
          if (dir === 'A') key.upArrow = true;
          else if (dir === 'B') key.downArrow = true;
          else if (dir === 'C') key.rightArrow = true;
          else if (dir === 'D') key.leftArrow = true;
          const seq = `\x1b[1;2${dir}`;
          events.push([seq, key]);
          i += seq.length;
          continue;
        }

        // Shift+Tab (backtab): \x1b[Z
        if (after.length >= 1 && after[0] === 'Z') {
          const key = emptyKey();
          key.tab = true;
          key.shift = true;
          const seq = `\x1b[Z`;
          events.push([seq, key]);
          i += seq.length;
          continue;
        }

        // Arrow keys: \x1b[A/B/C/D
        if (after.length >= 1 && 'ABCD'.includes(after[0]!)) {
          const key = emptyKey();
          const dir = after[0]!;
          if (dir === 'A') key.upArrow = true;
          else if (dir === 'B') key.downArrow = true;
          else if (dir === 'C') key.rightArrow = true;
          else if (dir === 'D') key.leftArrow = true;
          const seq = `\x1b[${dir}`;
          events.push([seq, key]);
          i += seq.length;
          continue;
        }

        // Tilde sequences: \x1b[N~
        const tildeMatch = after.match(/^(\d+)~/);
        if (tildeMatch) {
          const num = tildeMatch[1]!;
          const key = emptyKey();
          if (num === '5') key.pageUp = true;
          else if (num === '6') key.pageDown = true;
          else if (num === '3') key.delete = true;
          const seq = `\x1b[${num}~`;
          events.push([seq, key]);
          i += seq.length;
          continue;
        }

        // Incomplete CSI — need more data
        return { events, remaining: buf.slice(i) };
      }

      // Lone ESC — signal caller to wait (disambiguate vs CSI prefix)
      if (rest.length === 0) {
        return { events, remaining: buf.slice(i) };
      }

      // \x1b + regular char → Meta key
      const metaCh = rest[0]!;
      const key = emptyKey();
      key.meta = true;
      events.push([metaCh, key]);
      i += 2;
      continue;
    }

    // Return
    if (ch === '\r') {
      const key = emptyKey();
      key.return = true;
      events.push([ch, key]);
      i++;
      continue;
    }

    // Tab
    if (ch === '\t') {
      const key = emptyKey();
      key.tab = true;
      events.push([ch, key]);
      i++;
      continue;
    }

    // Backspace (DEL or BS)
    if (ch === '\x7f' || ch === '\x08') {
      const key = emptyKey();
      key.backspace = true;
      events.push([ch, key]);
      i++;
      continue;
    }

    // Ctrl+A–Z (\x01–\x1a)
    const code = ch.charCodeAt(0);
    if (code >= 0x01 && code <= 0x1a) {
      const key = emptyKey();
      key.ctrl = true;
      const letter = String.fromCharCode(code + 96);
      events.push([letter, key]);
      i++;
      continue;
    }

    // Printable / multibyte char
    events.push([ch, emptyKey()]);
    i++;
  }

  return { events, remaining: '' };
}

// ── Raw Stdin Bypass (for neovim PTY forwarding) ─────────────────────────────

let rawBypassHandler: ((data: string) => boolean) | null = null;

export function setRawBypass(handler: ((data: string) => boolean) | null): void {
  rawBypassHandler = handler;
}

export function startKeypressListener(handler: KeypressHandler): () => void {
  let buffer = '';
  let escTimer: ReturnType<typeof setTimeout> | null = null;

  const onData = (data: string): void => {
    // Raw bypass — forward to neovim PTY if active
    if (rawBypassHandler) {
      const handled = rawBypassHandler(data);
      if (handled) return;
    }

    // Cancel pending escape timer — more data arrived
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }

    buffer += data;

    const { events, remaining } = parseBuffer(buffer);
    buffer = remaining;

    for (const [input, key] of events) {
      handler(input, key);
    }

    // If buffer ends with lone ESC, start disambiguation timer
    if (buffer === '\x1b') {
      escTimer = setTimeout(() => {
        escTimer = null;
        buffer = '';
        const key = emptyKey();
        key.escape = true;
        handler('\x1b', key);
      }, 50);
    }
  };

  process.stdin.on('data', onData);

  return (): void => {
    process.stdin.off('data', onData);
    if (escTimer !== null) {
      clearTimeout(escTimer);
      escTimer = null;
    }
  };
}

// ── Resize Handler ───────────────────────────────────────────────────────────

export function onResize(callback: () => void): () => void {
  const onStdoutResize = (): void => callback();
  const onSigwinch = (): void => callback();

  process.stdout.on('resize', onStdoutResize);
  process.on('SIGWINCH', onSigwinch);

  return (): void => {
    process.stdout.off('resize', onStdoutResize);
    process.off('SIGWINCH', onSigwinch);
  };
}
