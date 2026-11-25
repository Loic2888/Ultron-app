/**
 * Runs Monaco from the app's own files, never from a CDN: by default the React
 * wrapper downloads the editor from jsDelivr, which would send a request out of
 * the machine. Loaded lazily, together with EditorView.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// A repo's imports cannot be resolved inside the browser, so type errors
// would be false alarms. Keep syntax errors, drop the semantic ones.
for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

monaco.editor.defineTheme('jarvis', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#07090b',
    'editor.foreground': '#ededef',
    'editorLineNumber.foreground': '#4b5563',
    'editorLineNumber.activeForeground': '#ef4444',
    'editorCursor.foreground': '#ef4444',
    'editor.selectionBackground': '#ef444433',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorWidget.background': '#0d1114',
    'editorGutter.background': '#07090b',
    'scrollbarSlider.background': '#ffffff1a',
  },
});

loader.config({ monaco });

export { monaco };
