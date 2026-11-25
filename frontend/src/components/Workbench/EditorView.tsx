import { useEffect, useRef } from 'react';
import Editor, { useMonaco, type OnMount } from '@monaco-editor/react';
import { Save } from 'lucide-react';

import './monacoSetup';
import { isDirty, useWorkspace } from './workspaceStore';

/** `file:///a/b%20c` — the model URI Monaco uses to tell files apart. */
export const fileUri = (path: string): string =>
  'file://' + path.split('/').map(encodeURIComponent).join('/');

const CONFLICT_TEXT =
  'This file was changed on disk after you opened it (by Claude Code, a terminal or another program).\n\n' +
  'Overwrite it with your version?';

/**
 * Monaco editor for one file. The text lives in the workspace store, so it
 * survives tab and repo switches; Monaco only displays it.
 */
export default function EditorView({
  path,
  repoPath,
  openPaths,
}: {
  path: string;
  repoPath: string;
  /** Every file open in a tab, in any repo: other models are released. */
  openPaths: string[];
}) {
  const monaco = useMonaco();
  const buffer = useWorkspace((s) => s.buffers[path]);
  const loadBuffer = useWorkspace((s) => s.loadBuffer);
  const setContent = useWorkspace((s) => s.setContent);
  const saveBuffer = useWorkspace((s) => s.saveBuffer);
  const pathRef = useRef(path);
  pathRef.current = path;

  // Show what is on disk now (unless the user has unsaved edits).
  useEffect(() => {
    void loadBuffer(path, true);
  }, [path, loadBuffer]);

  // Release the models of files whose tab was closed.
  const keep = openPaths.join('\n');
  useEffect(() => {
    if (!monaco) return;
    const wanted = new Set(keep.split('\n').filter(Boolean).map(fileUri));
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme === 'file' && !wanted.has(model.uri.toString())) model.dispose();
    }
  }, [monaco, keep]);

  const save = async () => {
    const target = pathRef.current;
    let result = await saveBuffer(target);
    if (result === 'conflict' && window.confirm(CONFLICT_TEXT)) {
      result = await saveBuffer(target, true);
    }
    return result;
  };

  const onMount: OnMount = (editor, m) => {
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
      void save();
    });
  };

  if (!buffer || buffer.status === 'loading') {
    return <Notice text="Opening…" />;
  }
  if (buffer.status === 'error') {
    return (
      <Notice
        text={buffer.error ?? 'Could not open the file.'}
        action={{ label: 'Try again', run: () => void loadBuffer(path) }}
        error
      />
    );
  }

  const relative = path.startsWith(repoPath + '/') ? path.slice(repoPath.length + 1) : path;
  const dirty = isDirty(buffer);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="flex items-center gap-2 px-3 py-1 text-xs shrink-0"
        // right padding keeps Save clear of the floating Ultron orb and gauges
        style={{ background: '#0a0c0e', borderBottom: '1px solid #000', color: 'var(--color-text-tertiary)', paddingRight: 116 }}
      >
        <span className="truncate" title={path}>
          {relative}
        </span>
        {dirty && (
          <span style={{ color: 'var(--color-warning, #f59e0b)' }} aria-label="Unsaved changes">
            ● unsaved
          </span>
        )}
        {buffer.error && (
          <span role="alert" style={{ color: 'var(--color-error)' }}>
            {buffer.error}
          </span>
        )}
        <button
          type="button"
          className="metal-btn ml-auto text-xs"
          disabled={!dirty}
          onClick={() => void save()}
          title="Save (Ctrl+S)"
        >
          <Save size={12} /> Save
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <Editor
          path={fileUri(path)}
          value={buffer.content}
          theme="jarvis"
          keepCurrentModel
          onChange={(value) => setContent(pathRef.current, value ?? '')}
          onMount={onMount}
          loading={<Notice text="Starting the editor…" />}
          options={{
            automaticLayout: true,
            fontSize: 13,
            fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
            tabSize: 2,
            padding: { top: 8 },
          }}
        />
      </div>
    </div>
  );
}

function Notice({
  text,
  action,
  error,
}: {
  text: string;
  action?: { label: string; run: () => void };
  error?: boolean;
}) {
  return (
    <div
      className="h-full flex flex-col items-center justify-center gap-2 text-xs px-6 text-center"
      style={{ color: error ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}
      role={error ? 'alert' : 'status'}
    >
      <span>{text}</span>
      {action && (
        <button type="button" className="metal-btn text-xs" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
