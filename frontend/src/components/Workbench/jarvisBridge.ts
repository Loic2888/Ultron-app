/**
 * Runs, on screen, the commands the Ultron assistant sends: open a repo, open
 * a Claude Code tab or a terminal, send a prompt, read a chat. Every command
 * either returns a plain result or throws an Error whose message Ultron reads,
 * so the messages are written for it ("Open the repo first with open_repo").
 */
import type { RepoInfo } from '../../lib/workspaceApi';
import type { ChatState } from './claudeStore';
import { toolSummary, type ChatModel } from './claudeModel';
import type { Tab } from './workspaceModel';

/** The small slice of the stores a command needs (real stores or test doubles). */
export interface BridgeDeps {
  workspace: () => {
    repos: { path: string; name: string }[];
    activeRepo: string | null;
    sessions: Record<string, { tabs: Tab[]; terms: Tab[] }>;
    addRepo: (repo: { path: string; name: string }) => void;
    selectRepo: (path: string) => void;
    addClaudeTab: (repo: string) => void;
    addTerminal: (repo: string) => void;
  };
  claude: () => {
    chats: Record<string, ChatState>;
    open: (key: string, cwd: string, kind?: 'code' | 'jarvis') => Promise<void>;
    send: (key: string, text: string) => Promise<void>;
  };
  getRepo: (path: string) => Promise<RepoInfo>;
  showWorkspace: () => void;
  sleep?: (ms: number) => Promise<void>;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The repo a command is about: the one named, else the active one. */
function repoOf(args: Record<string, unknown>, d: BridgeDeps): string {
  const ws = d.workspace();
  const wanted = text(args.repo) || ws.activeRepo;
  if (!wanted) throw new Error('No repository is open. Use open_repo first.');
  if (!ws.repos.some((r) => r.path === wanted)) {
    throw new Error(`${wanted} is not open. Use open_repo first.`);
  }
  return wanted;
}

/** Finds a chat by its id (or, failing that, by its title in the active repo). */
function findChat(ref: string, d: BridgeDeps): { key: string; repo: string; title: string } {
  const ws = d.workspace();
  const wanted = ref.trim();
  for (const [repo, session] of Object.entries(ws.sessions)) {
    for (const t of session.tabs) {
      if (t.kind === 'claude' && t.chat === wanted) return { key: t.chat, repo, title: t.title };
    }
  }
  const active = ws.activeRepo ? ws.sessions[ws.activeRepo] : undefined;
  const byTitle = active?.tabs.find((t) => t.kind === 'claude' && t.chat && t.title.toLowerCase() === wanted.toLowerCase());
  if (byTitle && byTitle.chat && ws.activeRepo) return { key: byTitle.chat, repo: ws.activeRepo, title: byTitle.title };
  throw new Error(`No Claude Code chat "${ref}". Use list_workspace to see the chat ids.`);
}

/** Latest answer of the chat: the assistant text written after the last user message. */
export function lastAnswer(model: ChatModel, maxChars: number): string {
  let from = 0;
  for (let i = model.items.length - 1; i >= 0; i--) {
    if (model.items[i].kind === 'user') {
      from = i + 1;
      break;
    }
  }
  const parts: string[] = [];
  for (const it of model.items.slice(from)) {
    if (it.kind === 'assistant') {
      for (const b of it.blocks) if (b.kind === 'text' && b.text.trim()) parts.push(b.text.trim());
    }
  }
  const joined = parts.join('\n\n');
  return joined.length > maxChars ? `…${joined.slice(joined.length - maxChars)}` : joined;
}

function describeChat(chat: ChatState | undefined, maxChars: number) {
  if (!chat) return { opened: false };
  const m = chat.model;
  return {
    opened: true,
    status: chat.status,
    busy: m.busy,
    waiting_for_owner_approval: m.approvals.map((a) => ({
      tool: a.display_name || a.tool_name,
      what: toolSummary(a.tool_name ?? '', a.input),
    })),
    last_answer: lastAnswer(m, maxChars),
    error: chat.error || undefined,
  };
}

export async function executeCommand(
  name: string,
  args: Record<string, unknown>,
  d: BridgeDeps,
): Promise<unknown> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  switch (name) {
    case 'list_workspace': {
      const ws = d.workspace();
      const chats = d.claude().chats;
      return {
        active_repo: ws.activeRepo,
        repos: ws.repos.map((r) => {
          const s = ws.sessions[r.path];
          return {
            path: r.path,
            name: r.name,
            active: r.path === ws.activeRepo,
            claude_chats: (s?.tabs ?? [])
              .filter((t) => t.kind === 'claude' && t.chat)
              .map((t) => ({
                chat: t.chat,
                title: t.title,
                busy: chats[t.chat as string]?.model.busy ?? false,
              })),
            open_files: (s?.tabs ?? []).filter((t) => t.kind === 'editor').map((t) => t.path),
            terminals: s?.terms.length ?? 0,
          };
        }),
      };
    }

    case 'open_repo': {
      const path = text(args.path);
      if (!path.startsWith('/')) throw new Error('Give an absolute path.');
      const info = await d.getRepo(path); // the server refuses anything outside the home folder
      d.workspace().addRepo({ path: info.path, name: info.name });
      d.workspace().selectRepo(info.path);
      d.showWorkspace();
      return { path: info.path, name: info.name, branch: info.branch, is_git: info.is_git };
    }

    case 'new_claude_tab': {
      const repo = repoOf(args, d);
      d.workspace().selectRepo(repo);
      d.workspace().addClaudeTab(repo);
      const tabs = d.workspace().sessions[repo].tabs;
      const tab = tabs[tabs.length - 1];
      if (!tab || tab.kind !== 'claude' || !tab.chat) throw new Error('The tab could not be created.');
      d.showWorkspace();
      const prompt = text(args.prompt);
      if (prompt) {
        await d.claude().open(tab.chat, repo);
        const chat = d.claude().chats[tab.chat];
        if (chat?.status !== 'ready') throw new Error(chat?.error || 'The chat did not start.');
        await d.claude().send(tab.chat, prompt);
      }
      return { chat: tab.chat, title: tab.title, repo, prompt_sent: prompt !== '' };
    }

    case 'new_terminal': {
      const repo = repoOf(args, d);
      d.workspace().selectRepo(repo);
      d.workspace().addTerminal(repo);
      d.showWorkspace();
      return { repo, terminals: d.workspace().sessions[repo].terms.length };
    }

    case 'send_prompt': {
      const message = text(args.text);
      if (!message) throw new Error('The message is empty.');
      const { key, repo, title } = findChat(text(args.chat), d);
      await d.claude().open(key, repo);
      const chat = d.claude().chats[key];
      if (chat?.status !== 'ready') throw new Error(chat?.error || 'The chat is not ready.');
      if (chat.model.busy) throw new Error(`${title} is still working. Wait for it to finish (read_chat).`);
      if (chat.model.approvals.length > 0) {
        throw new Error(`${title} is waiting for the owner's approval. Ask them to answer it first.`);
      }
      await d.claude().send(key, message);
      return { sent: true, chat: key, title };
    }

    case 'read_chat': {
      const { key, repo } = findChat(text(args.chat), d);
      const maxChars = Math.min(20000, Math.max(200, Number(args.max_chars) || 3000));
      const waitMs = Math.min(120, Math.max(0, Number(args.wait_seconds) || 0)) * 1000;
      if (!d.claude().chats[key]) await d.claude().open(key, repo);
      const end = Date.now() + waitMs;
      for (;;) {
        const chat = d.claude().chats[key];
        const stop = !chat || !chat.model.busy || chat.model.approvals.length > 0 || chat.status !== 'ready';
        if (stop || Date.now() >= end) return describeChat(chat, maxChars);
        await sleep(500);
      }
    }

    default:
      throw new Error(`The screen does not know the command "${name}".`);
  }
}
