import type { CustomRules } from '../../lib/claudeApi';

const KEY = 'jarvis.customRules';

export const EMPTY_RULES: CustomRules = {
  readonly: false,
  build_test: false,
  git_pr: false,
  install: false,
  files: false,
  docker: false,
  any_command: false,
  other_tools: false,
  allow_tools: [],
  allow_commands: [],
  allow_deletes: [],
};

/** The tickable rules, with the words shown to the owner (same list as the server). */
export const RULE_TOGGLES: { key: 'readonly' | 'build_test' | 'git_pr' | 'install' | 'files' | 'docker' | 'any_command'; label: string; hint: string; risky?: boolean }[] = [
  { key: 'readonly', label: 'Read-only commands', hint: 'ls, cat, grep, git status / diff / log … inside the repo.' },
  { key: 'build_test', label: 'Tests, lint and builds', hint: 'pytest, npm test / run build, cargo test, tsc, ruff check …' },
  {
    key: 'git_pr',
    label: 'Git and pull requests',
    hint: 'git add / commit / fetch, new branch, gh pr create / view / list / diff / comment, and git push of a named branch (never main, never --force).',
  },
  { key: 'install', label: 'Install dependencies', hint: 'npm install / ci, pip install, uv sync / add, cargo fetch, go mod download.' },
  { key: 'files', label: 'Create folders and files', hint: 'mkdir, touch (inside the repo).' },
  { key: 'docker', label: 'Docker', hint: 'docker ps / images / logs / build, docker compose ps / logs / up / build. Never rm, down or prune.' },
  {
    key: 'any_command',
    label: 'Any other command',
    hint: 'Runs everything except deletions, moves, sudo, git push / reset / clean, redirections that overwrite files, and pipes into a shell. Use with care.',
    risky: true,
  },
];

/** One pattern per line; blank lines and duplicates dropped. */
export function parsePatterns(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const p = line.trim().replace(/\s+/g, ' ');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function normalizeRules(raw: unknown): CustomRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    readonly: r.readonly === true,
    build_test: r.build_test === true,
    git_pr: r.git_pr === true,
    install: r.install === true,
    files: r.files === true,
    docker: r.docker === true,
    any_command: r.any_command === true,
    other_tools: r.other_tools === true,
    allow_tools: list(r.allow_tools),
    allow_commands: list(r.allow_commands),
    allow_deletes: list(r.allow_deletes),
  };
}

export function loadRules(): CustomRules {
  try {
    return normalizeRules(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return { ...EMPTY_RULES };
  }
}

export function saveRules(rules: CustomRules): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rules));
  } catch {
    // storage unavailable: the rules still apply for this session
  }
}

/** How many rules are on (for the badge next to "Custom"). */
export function activeRuleCount(r: CustomRules): number {
  return [r.readonly, r.build_test, r.git_pr, r.install, r.files, r.docker, r.other_tools, r.any_command].filter(Boolean).length + r.allow_tools.length + r.allow_commands.length + r.allow_deletes.length;
}


/** A tool the owner can let through, with what it does (names are those of `claude`). */
export interface ToolChoice {
  label: string;
  hint: string;
  tools: string[];
  risky?: boolean;
}

/** Everything an AI needs besides shell commands, grouped for the Custom page. */
export const TOOL_GROUPS: { title: string; items: ToolChoice[] }[] = [
  {
    title: 'Files',
    items: [
      { label: 'Read files outside the repo', hint: 'Read, Glob, Grep anywhere (can reach ~/.ssh, .env …). Inside the repo, “Read-only tools” below is enough.', tools: ['Read', 'Glob', 'Grep'], risky: true },
    ],
  },
  {
    title: 'Helpers',
    items: [
      { label: 'Sub-agents', hint: 'Task / Agent: lets Claude start helper agents.', tools: ['Task', 'Agent'] },
      { label: 'Skills', hint: 'Skill: run a skill (a saved procedure).', tools: ['Skill'] },
      { label: 'Task list', hint: 'TodoWrite: its own to-do list.', tools: ['TodoWrite'] },
      { label: 'Plan mode', hint: 'EnterPlanMode / ExitPlanMode.', tools: ['EnterPlanMode', 'ExitPlanMode'] },
      { label: 'Git worktrees', hint: 'EnterWorktree / ExitWorktree: work in a separate copy of the repo.', tools: ['EnterWorktree', 'ExitWorktree'] },
      { label: 'Background commands', hint: 'BashOutput, KillShell, TaskStop, Monitor: follow or stop a command running in the background.', tools: ['BashOutput', 'KillShell', 'KillBash', 'TaskStop', 'Monitor'] },
      { label: 'Notebooks (read)', hint: 'NotebookRead.', tools: ['NotebookRead'] },
    ],
  },
  {
    title: 'Internet',
    items: [
      { label: 'Web search', hint: 'WebSearch.', tools: ['WebSearch'] },
      { label: 'Fetch web pages', hint: 'WebFetch: downloads a URL (data can leave through the address).', tools: ['WebFetch'] },
    ],
  },
  {
    title: 'MCP (connected services, e.g. Linear, Slack, Gmail)',
    items: [
      { label: 'MCP tools that only read', hint: 'get_*, list_*, search_*, read_*, query_*, find_*, fetch_*, whoami, describe_*, view_* of every service.', tools: ['mcp__*__get_*', 'mcp__*__list_*', 'mcp__*__search_*', 'mcp__*__read_*', 'mcp__*__query_*', 'mcp__*__find_*', 'mcp__*__fetch_*', 'mcp__*__whoami', 'mcp__*__describe_*', 'mcp__*__view_*'] },
      { label: 'MCP resources', hint: 'ListMcpResourcesTool, ReadMcpResourceTool.', tools: ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'] },
      { label: 'MCP tools that write', hint: 'save_*, create_*, update_*, send_*, delete_* of every service: sends mails and messages, edits tickets. Prefer naming one service below.', tools: ['mcp__*'], risky: true },
    ],
  },
  {
    title: 'Schedules and notifications',
    items: [
      { label: 'Scheduled tasks', hint: 'CronCreate / CronList / CronDelete: runs work later, on its own.', tools: ['CronCreate', 'CronList', 'CronDelete'], risky: true },
      { label: 'Push notification', hint: 'PushNotification: notifies your phone.', tools: ['PushNotification'] },
    ],
  },
];

const ALL_CATALOG_TOOLS = new Set(TOOL_GROUPS.flatMap((g) => g.items.flatMap((i) => i.tools)));

/** A choice is on when every one of its tool names is in the list. */
export function choiceOn(allowTools: string[], c: ToolChoice): boolean {
  return c.tools.every((t) => allowTools.includes(t));
}

export function toggleChoice(allowTools: string[], c: ToolChoice, on: boolean): string[] {
  const rest = allowTools.filter((t) => !c.tools.includes(t));
  return on ? [...rest, ...c.tools] : rest;
}

/** The tool names written by hand (not part of any checkbox). */
export function extraTools(allowTools: string[]): string[] {
  return allowTools.filter((t) => !ALL_CATALOG_TOOLS.has(t));
}

/**
 * What "Always accept" adds to the rules for this request, or null when nothing can
 * be remembered (file edits are decided by the repo rule, not by a list).
 */
export function rememberFor(
  toolName: string | null | undefined,
  input: Record<string, unknown> | null | undefined,
): { list: 'allow_tools' | 'allow_commands'; pattern: string } | null {
  if (!toolName) return null;
  if (toolName === 'Bash') {
    const cmd = typeof input?.command === 'string' ? input.command.trim().replace(/\s+/g, ' ') : '';
    if (!cmd || cmd.length > 200 || cmd.includes('\n') || input?.dangerouslyDisableSandbox) return null;
    return { list: 'allow_commands', pattern: cmd };
  }
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'AskUserQuestion'].includes(toolName)) return null;
  return { list: 'allow_tools', pattern: toolName };
}

export function withRemembered(
  rules: CustomRules,
  add: { list: 'allow_tools' | 'allow_commands'; pattern: string },
): CustomRules {
  if (rules[add.list].includes(add.pattern)) return rules;
  return { ...rules, [add.list]: [...rules[add.list], add.pattern] };
}
