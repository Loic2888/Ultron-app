import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { describeClaude, describePhone } from './GetStartedPage';
import { phoneSummary } from './SettingsPage';
import { GetStartedPage } from './GetStartedPage';

describe('Get started', () => {
  it('points at this app, never at the original project downloads', () => {
    const html = renderToStaticMarkup(<GetStartedPage />);
    expect(html).toContain('jarvis desktop --create-shortcut');
    expect(html).toContain('claude login');
    expect(html).not.toContain('github.com');
    expect(html).not.toContain('releases');
    expect(html).not.toContain('Download');
  });

  it('tells what is missing for Claude Code', () => {
    expect(describeClaude(null, false).state).toBe('loading');
    expect(describeClaude({ installed: false, logged_in: false }, false).state).toBe('todo');
    expect(describeClaude({ installed: true, logged_in: false }, false).text).toContain('not signed in');
    const ok = describeClaude({ installed: true, logged_in: true, email: 'a@b.c' }, false);
    expect(ok.state).toBe('ok');
    expect(describeClaude(null, true).state).toBe('todo');
  });

  it('shows the phone bot state without any secret', () => {
    const off = { configured: false, running: false } as never;
    expect(describePhone(off, false).text).toContain('off');
    expect(phoneSummary(off, false)).toContain('Off');
    const on = { configured: true, running: true } as never;
    expect(describePhone(on, false).state).toBe('ok');
    expect(phoneSummary(on, false)).toBe('On');
  });
});
