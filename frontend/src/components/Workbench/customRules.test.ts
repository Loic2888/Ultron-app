import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
});

import { EMPTY_RULES, activeRuleCount, loadRules, normalizeRules, parsePatterns, saveRules } from './customRules';

beforeEach(() => memory.clear());

describe('custom rules on the screen side', () => {
  it('starts with everything off', () => {
    expect(loadRules()).toEqual(EMPTY_RULES);
    expect(activeRuleCount(EMPTY_RULES)).toBe(0);
  });

  it('saves and reloads, and survives garbage', () => {
    saveRules({ ...EMPTY_RULES, git_pr: true, allow_deletes: ['rm -rf dist'] });
    expect(loadRules()).toMatchObject({ git_pr: true, allow_deletes: ['rm -rf dist'], any_command: false });
    memory.set('jarvis.customRules', '{nope');
    expect(loadRules()).toEqual(EMPTY_RULES);
    expect(normalizeRules({ readonly: 'yes', allow_commands: [1, 'ls'] })).toEqual({ ...EMPTY_RULES, allow_commands: ['ls'] });
  });

  it('turns one-per-line text into clean patterns', () => {
    expect(parsePatterns('make   lint\n\n  make lint \nrm -rf dist\n')).toEqual(['make lint', 'rm -rf dist']);
  });

  it('counts ticked rules and listed commands for the badge', () => {
    expect(activeRuleCount({ ...EMPTY_RULES, readonly: true, git_pr: true, allow_commands: ['a', 'b'] })).toBe(4);
  });
});

describe('tool catalog', () => {
  it('toggles a choice and keeps hand-written tools apart', async () => {
    const { TOOL_GROUPS, choiceOn, toggleChoice, extraTools } = await import('./customRules');
    const skill = TOOL_GROUPS.flatMap((g) => g.items).find((i) => i.label === 'Skills')!;
    const on = toggleChoice(['mcp__x__save'], skill, true);
    expect(choiceOn(on, skill)).toBe(true);
    expect(extraTools(on)).toEqual(['mcp__x__save']);
    expect(choiceOn(toggleChoice(on, skill, false), skill)).toBe(false);
  });
});
