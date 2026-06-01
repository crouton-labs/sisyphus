export type TreeNodeType =
  | 'session' | 'cycle' | 'agent' | 'report'
  | 'messages' | 'message' | 'context' | 'context-file'
  | 'section' | 'needs-you-virtual' | 'inbox-row';

export type SectionKey = 'running' | 'done';

interface BaseTreeNode {
  id: string;
  type: TreeNodeType;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  sessionId: string;
  prefix?: string;
}

export interface SectionTreeNode extends BaseTreeNode {
  type: 'section';
  depth: 0;
  section: SectionKey;
  count: number;
  expanded: boolean;
  sessionId: '';
}

export interface NeedsYouVirtualTreeNode extends BaseTreeNode {
  type: 'needs-you-virtual';
  depth: 0;
  pendingCount: number;
  sessionId: '';
}

export interface SessionTreeNode extends BaseTreeNode {
  type: 'session';
  depth: 1;
  name?: string;
  task: string;
  status: string;
  cycleCount: number;
  agentCount: number;
  runningAgentCount: number;
  createdAt: string;
  completedAt?: string;
  activeMs: number;
  orphaned?: boolean;
}

export interface CycleTreeNode extends BaseTreeNode {
  type: 'cycle';
  depth: 2;
  cycleNumber: number;
  timestamp: string;
  completedAt?: string;
  activeMs: number;
  agentCount: number;
  mode?: string;
}

export interface AgentTreeNode extends BaseTreeNode {
  type: 'agent';
  depth: 3;
  agentId: string;
  name: string;
  agentType: string;
  status: string;
  spawnedAt: string;
  completedAt: string | null;
  activeMs: number;
  reportCount: number;
  orphaned?: boolean;
}

export interface ReportTreeNode extends BaseTreeNode {
  type: 'report';
  depth: 4;
  reportIndex: number;
  reportType: 'update' | 'final';
  timestamp: string;
  agentId: string;
}

export interface MessagesTreeNode extends BaseTreeNode {
  type: 'messages';
  depth: 2;
  count: number;
}

export interface MessageTreeNode extends BaseTreeNode {
  type: 'message';
  depth: 3;
  messageId: string;
  source: string;
  summary: string;
  timestamp: string;
}

export interface ContextTreeNode extends BaseTreeNode {
  type: 'context';
  depth: 2;
  fileCount: number;
}

export interface ContextFileTreeNode extends BaseTreeNode {
  type: 'context-file';
  depth: 3;
  label: string;
  filePath: string;
}

export type TreeNode =
  | SectionTreeNode
  | NeedsYouVirtualTreeNode
  | SessionTreeNode
  | CycleTreeNode
  | AgentTreeNode
  | ReportTreeNode
  | MessagesTreeNode
  | MessageTreeNode
  | ContextTreeNode
  | ContextFileTreeNode;
