/**
 * Live state of every Claude Code chat tab. A chat is identified by the stable
 * key stored in its tab. The conversation itself lives on the server (so a
 * page reload loses nothing); this store re-attaches to it and keeps one
 * streaming connection per chat.
 */
import { create } from 'zustand';

import * as api from '../../lib/claudeApi';
import type { ChatKind, CustomRules, PermissionMode } from '../../lib/claudeApi';
import { parseUnifiedWindows } from '../../lib/planUsage';
import { useAppStore } from '../../lib/store';
import { WorkspaceError } from '../../lib/workspaceApi';
import { emptyChat, reduceEvents, type ChatModel } from './claudeModel';
import { loadRules, saveRules } from './customRules';

const STORAGE_KEY = 'openjarvis.workbench.chats';
const MAX_RETRIES = 5;

export type ChatStatus = 'starting' | 'ready' | 'offline' | 'error';

export interface ChatState {
  key: string;
  cwd: string;
  kind: ChatKind;
  mode: PermissionMode;
  status: ChatStatus;
  error: string;
  sessionId: string | null;
  model: ChatModel;
  /** Model alias and effort chosen for this chat (null = the program's default). */
  modelChoice: string | null;
  effort: api.Effort | null;
  /** When the server started this chat (ms), for the timer. */
  startedAt: number | null;
  /** A message or an answer is being sent (disables the buttons briefly). */
  sending: boolean;
}

interface Saved {
  sessionId: string | null;
  claudeSessionId: string | null;
  mode: PermissionMode;
  modelChoice?: string | null;
  effort?: api.Effort | null;
}

function readSaved(): Record<string, Saved> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, Saved>) : {};
  } catch {
    return {};
  }
}

function writeSaved(map: Record<string, Saved>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage may be unavailable: the chat still works, it just is not re-attached
  }
}

const messageOf = (err: unknown, fallback: string): string =>
  err instanceof WorkspaceError ? err.message : err instanceof Error ? err.message : fallback;

interface Store {
  chats: Record<string, ChatState>;
  open: (key: string, cwd: string, kind?: ChatKind) => Promise<void>;
  reconnect: (key: string) => Promise<void>;
  send: (key: string, text: string) => Promise<void>;
  decide: (key: string, requestId: string, allow: boolean) => Promise<boolean>;
  interrupt: (key: string) => Promise<void>;
  changeMode: (key: string, mode: PermissionMode) => Promise<void>;
  changeSettings: (key: string, modelChoice: string | null, effort: api.Effort | null) => Promise<void>;
  /** The "Custom" rules, shared by every window (kept on this machine, pushed to open ones). */
  rules: CustomRules;
  setRules: (rules: CustomRules) => Promise<void>;
  close: (key: string) => Promise<void>;
}

const streams = new Map<string, AbortController>();
const opening = new Set<string>();

export const useClaude = create<Store>((set, get) => {
  const initialRules = loadRules();
  const patch = (key: string, p: Partial<ChatState>) =>
    set((s) => (s.chats[key] ? { chats: { ...s.chats, [key]: { ...s.chats[key], ...p } } } : s));

  const remember = (key: string) => {
    const c = get().chats[key];
    if (!c) return;
    writeSaved({
      ...readSaved(),
      [key]: {
        sessionId: c.sessionId,
        claudeSessionId: c.model.claudeSessionId,
        mode: c.mode,
        modelChoice: c.modelChoice,
        effort: c.effort,
      },
    });
  };

  const apply = (key: string, events: api.ServerEvent[]) => {
    const chat = get().chats[key];
    if (!chat) return;
    for (const e of events) {
      if (e.type === 'rate_limit_event') {
        const info = (e as { rate_limit_info?: { unifiedWindows?: unknown } }).rate_limit_info;
        const usage = parseUnifiedWindows(info?.unifiedWindows);
        if (usage) useAppStore.getState().setPlanUsage(usage);
      }
    }
    const before = chat.model.claudeSessionId;
    const model = reduceEvents(chat.model, events);
    patch(key, { model });
    if (model.claudeSessionId !== before) remember(key);
  };

  /** Streams events until the chat ends, retrying a few times on network errors. */
  const follow = async (key: string) => {
    streams.get(key)?.abort();
    const ctl = new AbortController();
    streams.set(key, ctl);
    let attempts = 0;
    while (!ctl.signal.aborted) {
      const chat = get().chats[key];
      if (!chat?.sessionId) return;
      try {
        await api.streamEvents(
          chat.sessionId,
          chat.model.lastSeq,
          (events) => {
            attempts = 0;
            apply(key, events);
          },
          ctl.signal,
        );
        return; // the server ended the stream: the chat was closed
      } catch (err) {
        if (ctl.signal.aborted) return;
        if (err instanceof WorkspaceError && err.status === 404) {
          // The server restarted and forgot the chat: start it again, resuming.
          patch(key, { sessionId: null });
          void get().open(key, chat.cwd, chat.kind);
          return;
        }
        attempts += 1;
        if (attempts > MAX_RETRIES) {
          patch(key, { status: 'offline', error: messageOf(err, 'Lost the connection to the server.') });
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempts)));
      }
    }
  };

  return {
    chats: {},
    rules: initialRules,

    setRules: async (rules) => {
      saveRules(rules);
      set({ rules });
      // Windows already in Custom mode get the new rules at once.
      await Promise.all(
        Object.values(get().chats)
          .filter((c) => c.mode === 'custom' && c.sessionId)
          .map((c) => api.setMode(c.sessionId as string, 'custom', rules).catch(() => undefined)),
      );
    },

    changeSettings: async (key, modelChoice, effort) => {
      const chat = get().chats[key];
      if (!chat) return;
      if (!chat.sessionId) {
        patch(key, { modelChoice, effort });
        return;
      }
      try {
        const s = await api.setSettings(chat.sessionId, modelChoice, effort);
        patch(key, { modelChoice: s.model ?? null, effort: s.effort ?? null, error: '' });
        remember(key);
      } catch (err) {
        patch(key, { error: messageOf(err, 'Could not change the model.') });
      }
    },

    open: async (key, cwd, kind = 'code') => {
      const existing = get().chats[key];
      if (opening.has(key) || (existing && existing.sessionId && existing.status === 'ready')) return;
      opening.add(key);
      try {
        const saved = readSaved()[key];
        const mode = existing?.mode ?? saved?.mode ?? 'auto';
        const model = existing?.model ?? emptyChat();
        set((s) => ({
          chats: {
            ...s.chats,
            [key]: {
              key,
              cwd,
              kind,
              mode,
              status: 'starting',
              error: '',
              sessionId: null,
              model,
              modelChoice: existing?.modelChoice ?? saved?.modelChoice ?? null,
              effort: existing?.effort ?? saved?.effort ?? null,
              startedAt: existing?.startedAt ?? null,
              sending: false,
            },
          },
        }));
        try {
          const status = await api.claudeStatus();
          if (!status.installed) {
            patch(key, {
              status: 'error',
              error: 'The `claude` program was not found. Install Claude Code, then run `claude login` in a terminal.',
            });
            return;
          }
          let sessionId: string | null = null;
          let fresh = model;
          if (saved?.sessionId) {
            try {
              const found = await api.getSession(saved.sessionId);
              if (!found.closed && found.cwd === cwd) {
                sessionId = found.id;
                patch(key, {
                  mode: found.permission_mode,
                  modelChoice: found.model ?? null,
                  effort: found.effort ?? null,
                  startedAt: found.created_at ? found.created_at * 1000 : null,
                });
                fresh = { ...emptyChat() }; // the server replays everything
              }
            } catch (err) {
              if (!(err instanceof WorkspaceError && err.status === 404)) throw err;
            }
          }
          if (!sessionId) {
            const resume = model.claudeSessionId ?? saved?.claudeSessionId ?? null;
            const now = get().chats[key];
            const created = await api.createSession(cwd, mode, resume, kind, {
              model: now?.modelChoice,
              effort: now?.effort,
              rules: mode === 'custom' ? get().rules : undefined,
            });
            sessionId = created.id;
            patch(key, { startedAt: created.created_at ? created.created_at * 1000 : Date.now() });
            fresh = { ...emptyChat(), claudeSessionId: resume };
          }
          patch(key, { sessionId, model: fresh, status: 'ready', error: '' });
          remember(key);
          void follow(key);
        } catch (err) {
          patch(key, { status: 'error', error: messageOf(err, 'Could not start this chat.') });
        }
      } finally {
        opening.delete(key);
      }
    },

    reconnect: async (key) => {
      const chat = get().chats[key];
      if (!chat) return;
      patch(key, { status: 'starting', error: '' });
      if (chat.sessionId) {
        patch(key, { status: 'ready' });
        void follow(key);
      } else {
        await get().open(key, chat.cwd, chat.kind);
      }
    },

    send: async (key, text) => {
      const chat = get().chats[key];
      if (!chat?.sessionId || chat.sending) return;
      patch(key, { sending: true });
      try {
        await api.sendMessage(chat.sessionId, text);
      } catch (err) {
        patch(key, { error: messageOf(err, 'Could not send the message.') });
        throw err;
      } finally {
        patch(key, { sending: false });
      }
    },

    decide: async (key, requestId, allow) => {
      const chat = get().chats[key];
      if (!chat?.sessionId) {
        patch(key, { error: 'This chat is not connected: your answer was not sent.' });
        return false;
      }
      try {
        await api.decide(chat.sessionId, requestId, allow);
        return true;
      } catch (err) {
        patch(key, { error: messageOf(err, 'Could not send your answer.') });
        return false;
      }
    },

    interrupt: async (key) => {
      const chat = get().chats[key];
      if (!chat?.sessionId) return;
      try {
        await api.interrupt(chat.sessionId);
      } catch (err) {
        patch(key, { error: messageOf(err, 'Could not stop Claude.') });
      }
    },

    changeMode: async (key, mode) => {
      const chat = get().chats[key];
      if (!chat?.sessionId) {
        patch(key, { mode });
        return;
      }
      try {
        const s = await api.setMode(chat.sessionId, mode, mode === 'custom' ? get().rules : undefined);
        patch(key, { mode: s.permission_mode, error: '' });
        remember(key);
      } catch (err) {
        patch(key, { error: messageOf(err, 'Could not change the mode.') });
      }
    },

    close: async (key) => {
      const chat = get().chats[key];
      streams.get(key)?.abort();
      streams.delete(key);
      const { [key]: _gone, ...rest } = readSaved();
      void _gone;
      writeSaved(rest);
      set((s) => {
        const { [key]: _removed, ...others } = s.chats;
        void _removed;
        return { chats: others };
      });
      if (chat?.sessionId) {
        try {
          await api.closeSession(chat.sessionId);
        } catch {
          // already gone
        }
      }
    },
  };
});

/** Forgets every stored chat of repos that are no longer open (called rarely). */
export function forgetChats(keysToKeep: Set<string>): void {
  const saved = readSaved();
  const kept = Object.fromEntries(Object.entries(saved).filter(([k]) => keysToKeep.has(k)));
  if (Object.keys(kept).length !== Object.keys(saved).length) writeSaved(kept);
}
