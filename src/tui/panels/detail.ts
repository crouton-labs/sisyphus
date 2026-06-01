import {
  buildPanelRows,
  buildEmptyPanelRows,
  type Rect,
} from '../render.js';
import type { AppState, CycleLog } from '../state.js';
import type {
  TreeNode,
  CycleTreeNode,
  AgentTreeNode,
  ReportTreeNode,
  MessageTreeNode,
  ContextFileTreeNode,
} from '../types/tree.js';
import type { Session, Agent, OrchestratorCycle, StatusDigest } from '../../shared/types.js';
import { computeActiveTimeMs } from '../../shared/utils.js';
import type { ReportBlock } from '../lib/reports.js';
import {
  statusColor,
  formatDuration,
  formatTime,
  truncate,
  wrapText,
  stripFrontmatter,
  cleanMarkdown,
  seg,
  singleLine,
  agentDisplayName,
  reportBadge,
  agentStatusIcon,
  agentTypeColor,
  durationColor,
  modeColor,
  messageSourceLabel,
  messageSourceColor,
  extractFirstSentence,
  divider,
  type DetailLine,
} from '../lib/format.js';
import { buildCycleFlowLines } from './cycle-flow.js';
import { coerceKind, sessionIdFromDir, askIdFromDir } from '../../shared/inbox-types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DetailContext {
  nodes: TreeNode[];
  session: Session | null;
  agents: Agent[];
  reportBlocks: ReportBlock[];
  detailReportBlocks: ReportBlock[];
  contextFileContent: string | null;
}

// ---------------------------------------------------------------------------
// PlanLine (copied from PlanView.tsx — no React dependency)
// ---------------------------------------------------------------------------

interface PlanLine {
  text: string;
  bold?: boolean;
  dim?: boolean;
  color?: string;
}

function buildPlanLines(content: string, maxLines: number, width: number): PlanLine[] {
  const clean = stripFrontmatter(content);
  if (!clean.trim()) return [];

  const contentWidth = width - 4;
  const lines: PlanLine[] = [];
  const rawLines = clean.split('\n');

  for (const rawLine of rawLines) {
    if (lines.length >= maxLines) break;

    const trimmed = rawLine.trim();

    // Skip frontmatter artifacts
    if (trimmed === '---') continue;

    // Headers — bold, with level-based indentation
    const headerMatch = rawLine.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1]!.length;
      const headerText = cleanMarkdown(headerMatch[2]!);
      const indent = '  '.repeat(Math.max(0, level - 1));
      if (lines.length > 0) lines.push({ text: ' ' });
      lines.push({
        text: `    ${indent}${headerText}`,
        bold: true,
        color: level <= 2 ? 'white' : undefined,
      });
      continue;
    }

    // Empty lines — pass through (but collapse multiples)
    if (!trimmed) {
      if (lines.length > 0 && lines[lines.length - 1]!.text !== '') {
        lines.push({ text: ' ' });
      }
      continue;
    }

    // Numbered list items
    const listMatch = trimmed.match(/^(\d+)[.)]\s+(.+)/);
    if (listMatch) {
      const cleaned = `${listMatch[1]}. ${cleanMarkdown(listMatch[2]!)}`;
      const wrapped = wrapText(cleaned, contentWidth - 6);
      for (const wl of wrapped) {
        if (lines.length >= maxLines) break;
        lines.push({ text: `    ${wl}`, dim: true });
      }
      continue;
    }

    // Checkbox items — must come before bullet match
    const checkboxMatch = trimmed.match(/^- \[( |x|X)\] (.+)/);
    if (checkboxMatch) {
      const checked = checkboxMatch[1] !== ' ';
      const checkboxText = cleanMarkdown(checkboxMatch[2]!);
      const icon = checked ? '☑' : '☐';
      const wrapped = wrapText(`${icon} ${checkboxText}`, contentWidth - 6);
      for (const wl of wrapped) {
        if (lines.length >= maxLines) break;
        lines.push({ text: `    ${wl}`, dim: true, color: checked ? 'green' : undefined });
      }
      continue;
    }

    // Bullet items
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)/);
    if (bulletMatch) {
      const cleaned = `· ${cleanMarkdown(bulletMatch[1]!)}`;
      const wrapped = wrapText(cleaned, contentWidth - 6);
      for (const wl of wrapped) {
        if (lines.length >= maxLines) break;
        lines.push({ text: `    ${wl}`, dim: true });
      }
      continue;
    }

    // Regular content — clean and wrap
    const cleaned = cleanMarkdown(trimmed);
    const wrapped = wrapText(cleaned, contentWidth - 4);
    for (const wl of wrapped) {
      if (lines.length >= maxLines) break;
      lines.push({ text: `    ${wl}`, dim: true });
    }
  }

  // Truncation indicator
  const totalContentLines = rawLines.filter((l) => l.trim()).length;
  if (lines.length >= maxLines && totalContentLines > maxLines) {
    lines[lines.length - 1] = { text: '    … [p] open in editor', dim: true };
  }

  return lines;
}

// ---------------------------------------------------------------------------
// buildSessionLines (ported from SessionDetail.tsx buildLines)
// ---------------------------------------------------------------------------

function buildSessionLines(
  session: Session,
  planContent: string,
  goalContent: string | undefined,
  width: number,
  paneAlive: boolean,
  strategyContent: string = '',
  flowExpanded: boolean = false,
): DetailLine[] {
  const lines: DetailLine[] = [];
  const contentWidth = width - 4;
  const agents = session.agents;
  const cycles = session.orchestratorCycles;
  const isDead = session.status === 'active' && !paneAlive;
  // Goal text
  const goalText = goalContent
    ? cleanMarkdown(stripFrontmatter(goalContent).trim())
    : session.task;
  goalText
    .split('\n')
    .flatMap((l) => wrapText(l, contentWidth - 2))
    .forEach((line, i) => {
      lines.push(singleLine(`${i === 0 ? ' ' : '  '}${line}`, { bold: true }));
    });

  // Status bar
  const lastCycle = cycles.length > 0 ? cycles[cycles.length - 1]! : null;
  const cycleNum = lastCycle !== null ? lastCycle.cycle : 0;
  const mode = lastCycle !== null && lastCycle.mode !== undefined ? lastCycle.mode : '';
  const runningAgents = agents.filter((a) => a.status === 'running').length;
  const completedAgents = agents.filter((a) => a.status === 'completed').length;
  const elapsed = formatDuration(session.createdAt, session.completedAt);
  const activeMs = computeActiveTimeMs(session);
  const activeTime = formatDuration(activeMs);
  const modeLabelColor = modeColor(mode);
  lines.push([
    seg('  '),
    seg(isDead ? '✕ dead' : session.status, {
      color: statusColor(isDead ? 'crashed' : session.status),
    }),
    seg(` · cycle ${cycleNum}`, { dim: true }),
    ...(mode ? [seg(' (', { dim: true }), seg(mode, { color: modeLabelColor }), seg(')', { dim: true })] : []),
    seg(` · ${elapsed} · `, { dim: true }),
    seg(`${runningAgents} running`, { color: 'green' }),
    seg(' · ', { dim: true }),
    seg(`${completedAgents} done`, { color: 'cyan' }),
    seg(` · ${activeTime} active`, { dim: true }),
  ]);

  // Dead session warning
  if (isDead) {
    lines.push([
      seg('  '),
      seg(' ✕ DEAD ', { color: 'red', bold: true }),
      seg(' tmux window closed — [w] reopen  [R] resume', { color: 'red' }),
    ]);
  }

  // Orphan tag
  if (session.orphaned) {
    lines.push([
      seg('  '),
      seg('⚠ orphan', { color: 'red', bold: true }),
      seg(' — orchestrator process lost', { color: 'red' }),
    ]);
  }

  // Plan / Strategy section
  lines.push(singleLine(' '));
  if (strategyContent) {
    lines.push([seg('  ▎ ◈ STRATEGY', { color: 'yellow', bold: true })]);
    const stratLines = buildPlanLines(strategyContent, 99999, width);
    if (stratLines.length === 0) {
      lines.push(singleLine('    (empty)', { dim: true, italic: true }));
    } else {
      for (const pl of stratLines) {
        lines.push(singleLine(pl.text, { bold: pl.bold, dim: pl.dim, color: pl.color }));
      }
    }
  } else {
    lines.push([seg('  ▎ ◈ PLAN', { color: 'yellow', bold: true })]);
    const planLines = buildPlanLines(planContent, 99999, width);
    if (planLines.length === 0) {
      lines.push(singleLine('    orchestrator will create one', { dim: true, italic: true }));
    } else {
      for (const pl of planLines) {
        lines.push(singleLine(pl.text, { bold: pl.bold, dim: pl.dim, color: pl.color }));
      }
    }
  }

  // Completion report
  if (session.status === 'completed' && session.completionReport) {
    lines.push(singleLine(' '));
    lines.push([seg('  ▎ ✓ COMPLETION', { color: 'cyan', bold: true })]);
    wrapText(session.completionReport, contentWidth - 6).forEach((l) => {
      lines.push(singleLine(`    ${l}`, { dim: true }));
    });
  }

  // Cycle flow visualization
  lines.push(singleLine(' '));
  lines.push(...buildCycleFlowLines(session, contentWidth, flowExpanded));

  return lines;
}

// ---------------------------------------------------------------------------
// buildCycleLines (ported from CycleDetail.tsx buildLines)
// ---------------------------------------------------------------------------

function buildCycleLines(cycle: OrchestratorCycle, agents: Agent[], width: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const contentWidth = width - 4;
  const isRunning = !cycle.completedAt;
  const dur = isRunning ? 'running' : formatDuration(cycle.activeMs);
  const cycleAgents = agents.filter((a) => cycle.agentsSpawned.includes(a.id));

  lines.push(singleLine(` Cycle ${cycle.cycle}`, { bold: true }));
  lines.push([
    seg('  '),
    seg(isRunning ? 'running' : 'completed', { color: isRunning ? 'green' : 'gray' }),
    seg(` · ${dur} · ${cycleAgents.length} agent${cycleAgents.length !== 1 ? 's' : ''}`, { dim: true }),
    ...(cycle.mode
      ? [seg(' · ', { dim: true }), seg(cycle.mode, { color: modeColor(cycle.mode) })]
      : []),
  ]);
  lines.push(singleLine(
    `  ${formatTime(cycle.timestamp)}${cycle.completedAt ? ` → ${formatTime(cycle.completedAt)}` : ''}`,
    { dim: true },
  ));
  if (cycle.claudeSessionId) {
    lines.push(singleLine(`  Session: ${cycle.claudeSessionId}`, { dim: true }));
  }

  lines.push(singleLine(' '));
  lines.push([seg('  ▎ ⊞ AGENTS', { color: 'green', bold: true })]);

  if (cycleAgents.length === 0) {
    lines.push(singleLine('    orchestrator spawning agents…', { dim: true, italic: true }));
  } else {
    for (const agent of cycleAgents) {
      const nameLabel = agentDisplayName(agent);
      const instrPreview = agent.instruction.split('\n')[0]!;
      const latestReport = agent.reports.length > 0 ? agent.reports[agent.reports.length - 1]! : null;
      const reportSummary = latestReport !== null && agent.status === 'completed'
        ? extractFirstSentence(latestReport.summary, contentWidth - 14)
        : null;
      const agentDur = formatDuration(agent.activeMs);
      const durClrRaw = durationColor(agent.activeMs);
      const durClr = durClrRaw !== '' ? durClrRaw : undefined;
      const typeClrRaw = agentTypeColor(agent.agentType);
      const typeClr = typeClrRaw !== undefined ? typeClrRaw : undefined;

      lines.push([
        seg('    '),
        seg(agentStatusIcon(agent.status), { color: statusColor(agent.status) }),
        seg(` ${agent.id}`, { bold: true }),
        seg(` ${truncate(nameLabel, contentWidth - 30)}`, {
          color: typeClr,
          dim: typeClr === undefined,
        }),
        seg(` · ${agent.status} · `, { dim: true }),
        seg(agentDur, { color: durClr, dim: !durClr }),
      ]);

      if (instrPreview) {
        lines.push(singleLine(`      ${truncate(instrPreview, contentWidth - 10)}`, { dim: true }));
      }

      if (reportSummary) {
        lines.push([
          seg('      '),
          seg('↳', { color: 'cyan' }),
          seg(` ${reportSummary}`, { dim: true }),
        ]);
      }
    }
  }

  if (cycle.nextPrompt) {
    lines.push(singleLine(' '));
    lines.push([seg('  ▎ ▷ NEXT PROMPT', { color: 'yellow', bold: true })]);
    for (const wl of wrapText(cycle.nextPrompt, contentWidth - 6)) {
      lines.push(singleLine(`    ${wl}`, { dim: true }));
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// buildAgentLines (ported from AgentDetail.tsx buildLines)
// ---------------------------------------------------------------------------

function buildAgentLines(agent: Agent, reportBlocks: ReportBlock[] | undefined, width: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const contentWidth = width - 4;
  const dur = formatDuration(agent.activeMs);
  const icon = agentStatusIcon(agent.status);
  const color = statusColor(agent.status);
  const nameLabel = agentDisplayName(agent);
  lines.push([
    seg(' '),
    seg(icon, { color }),
    seg(` ${agent.id} · ${nameLabel}`, { bold: true }),
  ]);

  lines.push([
    seg('  '),
    seg(agent.status, { color }),
    seg(` · ${dur} · ${agent.agentType}`, { dim: true }),
  ]);

  if (agent.killedReason) {
    lines.push(singleLine(`  ⚠ ${agent.killedReason}`, { color: 'red' }));
  }

  lines.push(singleLine(' '));
  lines.push(singleLine('  ▎ ▷ INSTRUCTION', { color: 'white', bold: true }));
  for (const wl of wrapText(agent.instruction, contentWidth - 6)) {
    lines.push(singleLine(`    ${wl}`, { dim: true }));
  }

  if (agent.reports.length > 0) {
    const hasResolved = reportBlocks && reportBlocks.length > 0;
    lines.push(singleLine(' '));
    lines.push([seg(`  ▎ ◇ REPORTS (${agent.reports.length})`, { color: 'cyan', bold: true })]);

    if (hasResolved) {
      for (let i = 0; i < reportBlocks.length; i++) {
        const block = reportBlocks[i]!;
        const { label: badge, color: badgeColor } = reportBadge(block.type);

        if (i > 0) lines.push(singleLine(' '));
        lines.push([
          seg('    '),
          seg(badge, { color: badgeColor, bold: block.type === 'final' }),
          seg(` ${formatTime(block.timestamp)}`, { dim: true }),
        ]);
        for (const wl of wrapText(block.content.trim(), contentWidth - 10)) {
          lines.push(singleLine(`      ${wl}`, { dim: true }));
        }
      }
    } else {
      for (const report of agent.reports) {
        const { label: badge, color: badgeColor } = reportBadge(report.type);
        lines.push([
          seg('    '),
          seg(badge, { color: badgeColor, bold: report.type === 'final' }),
          seg(` ${formatTime(report.timestamp)}  ${report.summary.split('\n')[0]}`, { dim: true }),
        ]);
      }
    }
  }

  lines.push(singleLine(' '));
  lines.push(singleLine('  ▎ ◦ META', { color: 'gray', bold: true }));
  lines.push(singleLine(`    Spawned: ${formatTime(agent.spawnedAt)}`, { dim: true }));
  if (agent.completedAt) {
    lines.push(singleLine(`    Completed: ${formatTime(agent.completedAt)}`, { dim: true }));
  }
  if (agent.claudeSessionId) {
    lines.push(singleLine(`    Session: ${agent.claudeSessionId}`, { dim: true }));
  }
  if (agent.paneId) {
    lines.push(singleLine(`    Pane: ${agent.paneId}`, { dim: true }));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// buildReportViewLines (ported from ReportView.tsx buildLines)
// ---------------------------------------------------------------------------

function buildReportViewLines(agent: Agent, reportBlocks: ReportBlock[], width: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const contentWidth = width - 6;
  const dur = formatDuration(agent.activeMs);
  const icon = agentStatusIcon(agent.status);
  const color = statusColor(agent.status);
  const totalReports = agent.reports.length;
  const nameLabel = agentDisplayName(agent);

  lines.push([
    seg(' '),
    seg(icon, { color }),
    seg(' '),
    seg(agent.id, { bold: true }),
    seg(' ', { dim: true }),
    seg('·', { dim: true }),
    seg(' '),
    seg(nameLabel, { bold: true }),
  ]);

  lines.push(singleLine(
    `  ${agent.status} · ${dur} · ${agent.agentType} · ${totalReports} report${totalReports !== 1 ? 's' : ''}`,
    { dim: true },
  ));

  lines.push(singleLine('  ' + divider(contentWidth - 2), { dim: true }));

  if (reportBlocks.length === 0) {
    lines.push(singleLine(''));
    lines.push(singleLine('  No reports submitted yet.', { dim: true }));
    lines.push(singleLine(''));
    return lines;
  }

  for (let i = 0; i < reportBlocks.length; i++) {
    const report = reportBlocks[i]!;
    const time = formatTime(report.timestamp);

    if (i > 0) {
      lines.push(singleLine(''));
      lines.push(singleLine(`  ${divider(contentWidth - 2, '·')}`, { dim: true }));
      lines.push(singleLine(''));
    }

    const { label: badge, color: badgeColor } = reportBadge(report.type);
    lines.push([
      seg(`  ${badge}`, { color: badgeColor, bold: report.type === 'final' }),
      seg(`  ${time}`, { color: badgeColor }),
    ]);

    lines.push(singleLine(''));

    const wrapped = wrapText(report.content.trim(), contentWidth - 4);
    for (const line of wrapped) {
      lines.push(singleLine(`    ${line}`));
    }
  }

  lines.push(singleLine(''));
  return lines;
}

// ---------------------------------------------------------------------------
// buildLogsLines (ported from LogsPanel.tsx buildLines)
// ---------------------------------------------------------------------------

export function buildLogsLines(cycleLogs: CycleLog[], width: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const contentWidth = width - 4;

  if (cycleLogs.length === 0) {
    return lines;
  }

  const sorted = [...cycleLogs].sort((a, b) => b.cycle - a.cycle);

  for (const { cycle, content } of sorted) {
    lines.push([seg(`  Cycle ${cycle}`, { color: 'blue', bold: true })]);

    const cleaned = cleanMarkdown(stripFrontmatter(content)).trim();
    if (cleaned) {
      for (const rawLine of cleaned.split('\n')) {
        const wrapped = wrapText(rawLine, contentWidth - 2);
        for (const wl of wrapped) {
          lines.push([seg(`    ${wl}`, { dim: true })]);
        }
      }
    }

    lines.push([seg(' ')]);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

export function renderDetailRows(
  rect: Rect,
  state: AppState,
  detailCtx: DetailContext,
): string[] {
  const { session, agents, reportBlocks, detailReportBlocks, contextFileContent } = detailCtx;
  const focused = state.focusPane === 'detail';

  // Report detail mode — full panel
  if (state.mode === 'report-detail') {
    const reportAgent = agents.find((a) => a.id === state.targetAgentId);
    if (reportAgent) {
      const lines = buildReportViewLines(reportAgent, reportBlocks, rect.w);
      return buildPanelRows(rect, lines, state.detailScroll, focused, 'cyan');
    }
  }

  // No cursor / no session → empty state
  const cursorNode: TreeNode | undefined = detailCtx.nodes[state.cursorIndex];
  if (!cursorNode || !session) {
    return buildEmptyPanelRows(rect, false, 'gray', '\x1b[2mSelect a session to view details\x1b[0m');
  }

  // Session data hasn't arrived yet (poll debounced during rapid scrolling)
  if (cursorNode.sessionId !== session.id) {
    return buildEmptyPanelRows(rect, false, 'gray');
  }

  // Compute cache key from all inputs that affect line building
  const lastCycle = session.orchestratorCycles[session.orchestratorCycles.length - 1];
  const cacheKey = [
    cursorNode.id,
    cursorNode.type,
    state.mode,
    state.targetAgentId,
    rect.w,
    session.id,
    session.agents.length,
    session.orchestratorCycles.length,
    lastCycle?.completedAt ?? '',
    lastCycle?.agentsSpawned.length ?? 0,
    state.planContent.length,
    state.goalContent.length,
    state.strategyContent.length,
    state.paneAlive,
    detailReportBlocks.length,
    session.messages.length,
    state.contextFiles.length,
    contextFileContent?.length ?? -1,
    state.flowExpanded,
  ].join(':');

  let lines: DetailLine[];
  let borderColor = 'gray';

  if (cacheKey === state.detailCacheKey && state.cachedDetailLines !== null) {
    lines = state.cachedDetailLines;
  } else {
    switch (cursorNode.type) {
      case 'session': {
        lines = buildSessionLines(session, state.planContent, state.goalContent, rect.w, state.paneAlive, state.strategyContent, state.flowExpanded);
        break;
      }

      case 'cycle': {
        const cycleNode = cursorNode as CycleTreeNode;
        const cycle = session.orchestratorCycles.find((c) => c.cycle === cycleNode.cycleNumber);
        if (!cycle) {
          lines = buildSessionLines(session, state.planContent, state.goalContent, rect.w, state.paneAlive, state.strategyContent, state.flowExpanded);
        } else {
          lines = buildCycleLines(cycle, session.agents, rect.w);
        }
        break;
      }

      case 'agent': {
        const agentNode = cursorNode as AgentTreeNode;
        const agent = agents.find((a) => a.id === agentNode.agentId);
        if (!agent) {
          lines = buildSessionLines(session, state.planContent, state.goalContent, rect.w, state.paneAlive, state.strategyContent, state.flowExpanded);
        } else {
          lines = buildAgentLines(agent, detailReportBlocks, rect.w);
        }
        break;
      }

      case 'report': {
        const reportNode = cursorNode as ReportTreeNode;
        const agent = agents.find((a) => a.id === reportNode.agentId);
        if (!agent) {
          lines = buildSessionLines(session, state.planContent, state.goalContent, rect.w, state.paneAlive, state.strategyContent, state.flowExpanded);
          break;
        }
        const reportIdx = reportNode.reportIndex;
        const specificBlock = detailReportBlocks.find((_b, i) => {
          const originalIdx = agent.reports.length - 1 - i;
          return originalIdx === reportIdx;
        });
        if (specificBlock) {
          const { label: badge, color: badgeColor } = reportBadge(specificBlock.type);
          lines = [
            [seg(' '), seg(badge, { color: badgeColor }), seg(` ${agent.id} · ${agentDisplayName(agent)}`, { bold: true })],
            singleLine(`  ${formatTime(specificBlock.timestamp)}`, { dim: true }),
            singleLine(' '),
            [seg('  ▎ CONTENT', { color: badgeColor, bold: true })],
            ...wrapText(specificBlock.content.trim(), rect.w - 8).map((l) => singleLine(`    ${l}`)),
          ];
          borderColor = badgeColor;
        } else {
          lines = buildAgentLines(agent, detailReportBlocks, rect.w);
        }
        break;
      }

      case 'messages': {
        lines = [singleLine(` Messages (${session.messages.length})`, { bold: true })];
        if (session.messages.length === 0) {
          lines.push(singleLine('  No messages', { dim: true, italic: true }));
        } else {
          for (const msg of session.messages) {
            const time = formatTime(msg.timestamp);
            const agentId = msg.source.type === 'agent' ? msg.source.agentId : undefined;
            const label = messageSourceLabel(msg.source.type, agentId);
            const labelColor = messageSourceColor(msg.source.type);
            const maxContent = Math.max(10, rect.w - label.length - 20);
            lines.push([
              seg(`  [${time}] `, { dim: true }),
              seg(`${label}: `, { color: labelColor, bold: true }),
              seg(wrapText(msg.summary.length > 0 ? msg.summary : msg.content, maxContent)[0]!, {}),
            ]);
          }
        }
        break;
      }

      case 'message': {
        const msgNode = cursorNode as MessageTreeNode;
        const msg = session.messages.find((m) => m.id === msgNode.messageId);
        lines = [singleLine(' Message', { bold: true })];
        if (msg) {
          lines.push(singleLine(`  ${msgNode.source} · ${msgNode.timestamp}`, { dim: true }));
          for (const l of wrapText(msg.content, rect.w - 8)) {
            lines.push(singleLine(`  ${l}`));
          }
        } else {
          lines.push(singleLine('  Message not found', { dim: true }));
        }
        break;
      }

      case 'context': {
        lines = [
          [seg(' '), seg('⊞', { color: 'white' }), seg(` Context (${state.contextFiles.length})`, { bold: true })],
        ];
        if (state.contextFiles.length === 0) {
          lines.push(singleLine('  No context files found.', { dim: true }));
        } else {
          for (const f of state.contextFiles) {
            lines.push(singleLine(`  · ${f}`, { dim: true }));
          }
        }
        break;
      }

      case 'context-file': {
        const ctxFileNode = cursorNode as ContextFileTreeNode;
        lines = [
          [seg(' '), seg('⊞', { color: 'white' }), seg(` ${ctxFileNode.label}`, { bold: true })],
          singleLine(' '),
        ];
        if (contextFileContent == null) {
          lines.push(singleLine('  File not found or unreadable.', { dim: true }));
        } else {
          const wrapped = wrapText(stripFrontmatter(contextFileContent), rect.w - 8);
          if (wrapped.length === 0) {
            lines.push(singleLine('  (empty)', { dim: true }));
          } else {
            for (const l of wrapped) {
              lines.push(singleLine(`    ${l}`));
            }
          }
        }
        borderColor = 'white';
        break;
      }

      default: {
        lines = buildSessionLines(session, state.planContent, state.goalContent, rect.w, state.paneAlive, state.strategyContent, state.flowExpanded);
        break;
      }
    }

    state.cachedDetailLines = lines;
    state.detailCacheKey = cacheKey;
  }

  // Compute borderColor from node type (cheap, no need to cache)
  if (cursorNode.type === 'context-file') {
    borderColor = 'white';
  } else if (cursorNode.type === 'report') {
    const reportNode = cursorNode as ReportTreeNode;
    const agent = agents.find((a) => a.id === reportNode.agentId);
    if (agent) {
      const reportIdx = reportNode.reportIndex;
      const specificBlock = detailReportBlocks.find((_b, i) => {
        const originalIdx = agent.reports.length - 1 - i;
        return originalIdx === reportIdx;
      });
      if (specificBlock) borderColor = reportBadge(specificBlock.type).color;
    }
  }

  return buildPanelRows(rect, lines, state.detailScroll, focused, borderColor, state.detailRenderedCache);
}

// ---------------------------------------------------------------------------
// buildDigestLines / renderDigestRows
// ---------------------------------------------------------------------------

function buildDigestLines(digest: StatusDigest, width: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const contentWidth = width - 4;

  // Recent Work
  lines.push([seg('  Recent Work', { color: 'cyan', bold: true })]);
  for (const wl of wrapText(digest.recentWork, contentWidth - 4)) {
    lines.push(singleLine(`    ${wl}`));
  }
  lines.push(singleLine(''));

  // Current Activity
  lines.push([seg('  Now', { color: 'white', bold: true })]);
  for (const wl of wrapText(digest.currentActivity, contentWidth - 4)) {
    lines.push(singleLine(`    ${wl}`));
  }
  lines.push(singleLine(''));

  // What's Next
  lines.push([seg('  Up Next', { color: 'white', bold: true })]);
  for (const wl of wrapText(digest.whatsNext, contentWidth - 4)) {
    lines.push([seg(`    ${wl}`, { dim: true })]);
  }
  lines.push(singleLine(''));

  // Unusual Events
  if (digest.unusualEvents.length > 0) {
    lines.push([seg('  Unusual', { color: 'yellow', bold: true })]);
    for (const event of digest.unusualEvents) {
      for (const wl of wrapText(`· ${event}`, contentWidth - 4)) {
        lines.push([seg(`    ${wl}`, { color: 'yellow' })]);
      }
    }
  }

  return lines;
}

function buildDoneDigestLines(session: Session, digest: StatusDigest | null, width: number): DetailLine[] {
  const lines: DetailLine[] = [];
  const contentWidth = width - 4;

  // KPI band — most-asked stats first
  const kpiCycles = session.orchestratorCycles.length;
  const kpiAgents = session.agents.length;
  const kpiWall = session.wallClockMs
    ? formatMs(session.wallClockMs)
    : (session.completedAt ? formatDuration(session.createdAt, session.completedAt) : '—');
  const kpiActive = formatMs(computeActiveTimeMs(session));

  lines.push([seg('  Stats', { color: 'cyan', bold: true })]);
  lines.push([
    seg('    cycles ', { dim: true }),
    seg(String(kpiCycles), { color: 'white', bold: true }),
    seg('  ·  agents ', { dim: true }),
    seg(String(kpiAgents), { color: 'white', bold: true }),
  ]);
  lines.push([
    seg('    wall ', { dim: true }),
    seg(kpiWall, { color: 'white', bold: true }),
    seg('  ·  active ', { dim: true }),
    seg(kpiActive, { color: 'white', bold: true }),
  ]);
  lines.push(singleLine(''));

  // What shipped (recapped from digest if present)
  if (digest?.recentWork) {
    lines.push([seg('  What shipped', { color: 'cyan', bold: true })]);
    for (const wl of wrapText(digest.recentWork, contentWidth - 4)) {
      lines.push(singleLine(`    ${wl}`));
    }
    lines.push(singleLine(''));
  }

  // Final state — replaces Now/Up Next
  lines.push([seg('  Final', { color: 'white', bold: true })]);
  if (session.completedAt) {
    lines.push([seg(`    completed ${formatTimestampShort(session.completedAt)}`, { dim: true })]);
  }
  if (digest?.currentActivity) {
    for (const wl of wrapText(digest.currentActivity, contentWidth - 4)) {
      lines.push([seg(`    ${wl}`, { dim: true })]);
    }
  }
  lines.push(singleLine(''));

  // Notable — preserved from Unusual; still useful post-hoc
  if (digest && digest.unusualEvents.length > 0) {
    lines.push([seg('  Notable', { color: 'yellow', bold: true })]);
    for (const event of digest.unusualEvents) {
      for (const wl of wrapText(`· ${event}`, contentWidth - 4)) {
        lines.push([seg(`    ${wl}`, { color: 'yellow' })]);
      }
    }
  }

  return lines;
}

function formatMs(ms: number): string {
  if (!ms || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 ? ` ${sec % 60}s` : ''}`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

function formatTimestampShort(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function renderFleetRollup(rect: Rect, state: AppState, focused: boolean): string[] {
  const items = state.aggregateInbox;
  const sessions = state.sessions;
  const cacheKey = `rollup:${items.length}:${sessions.length}:${items.map(i => `${askIdFromDir(i.dir)}:${i.blockedSince}`).join(',')}:${rect.w}`;
  let lines: DetailLine[];
  if (cacheKey === state.digestCacheKey && state.cachedDigestLines !== null) {
    lines = state.cachedDigestLines;
  } else {
    const byKind = new Map<string, number>();
    for (const i of items) {
      const k = coerceKind(i.kind);
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    const byStatus = new Map<string, number>();
    for (const s of sessions) {
      byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
    }
    const uniqueSessions = new Set(items.map(i => sessionIdFromDir(i.dir))).size;
    lines = [];
    lines.push([seg('  Inbox', { color: 'red', bold: true })]);
    lines.push(singleLine(`    ${items.length} pending across ${uniqueSessions} sessions`, { dim: true }));
    lines.push(singleLine(' '));
    lines.push([seg('  By Type', { color: 'cyan', bold: true })]);
    for (const [kind, count] of byKind) {
      lines.push(singleLine(`    · ${kind}: ${count}`, { dim: true }));
    }
    lines.push(singleLine(' '));
    lines.push([seg('  Sessions', { color: 'white', bold: true })]);
    for (const [status, count] of byStatus) {
      lines.push(singleLine(`    · ${status}: ${count}`, { dim: true }));
    }
    state.cachedDigestLines = lines;
    state.digestCacheKey = cacheKey;
  }
  return buildPanelRows(rect, lines, state.digestScroll, focused, 'red', state.digestRenderedCache);
}

export function renderDigestRows(
  rect: Rect,
  state: AppState,
): string[] {
  const focused = state.focusPane === 'logs';
  const digest = state.digestData;
  const session = state.selectedSession;

  if (state.detailMode === 'cross-session-inbox') {
    return renderFleetRollup(rect, state, focused);
  }

  if (!digest && !session) {
    return buildEmptyPanelRows(rect, focused, 'cyan', '\x1b[2mAwaiting digest...\x1b[0m');
  }

  // Combined cache key: digest + flow inputs
  const lastCycle = session?.orchestratorCycles[session.orchestratorCycles.length - 1];
  const agentStatuses = session?.agents.map(a => `${a.id}:${a.status}`).join(',') ?? '';
  const isDone = session?.status === 'completed';
  const cacheKey = [
    JSON.stringify(digest),
    session?.id ?? '',
    session?.status ?? '',
    session?.orchestratorCycles.length ?? 0,
    lastCycle?.completedAt ?? '',
    lastCycle?.agentsSpawned.length ?? 0,
    lastCycle?.nextPrompt?.length ?? 0,
    agentStatuses,
    state.flowExpanded,
    rect.w,
  ].join(':');

  let lines: DetailLine[];
  if (cacheKey === state.digestCacheKey && state.cachedDigestLines !== null) {
    lines = state.cachedDigestLines;
  } else {
    lines = [];
    if (isDone && session) {
      lines.push(...buildDoneDigestLines(session, digest, rect.w));
    } else if (digest) {
      lines.push(...buildDigestLines(digest, rect.w));
    }
    if (session) {
      lines.push(singleLine(''));
      lines.push(...buildCycleFlowLines(session, rect.w - 4, state.flowExpanded));
    }
    state.cachedDigestLines = lines;
    state.digestCacheKey = cacheKey;
  }

  return buildPanelRows(rect, lines, state.digestScroll, focused, 'cyan', state.digestRenderedCache);
}


