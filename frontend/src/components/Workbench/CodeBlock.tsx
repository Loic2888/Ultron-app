import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/** A command to copy: dark inset box with a copy button. */
export function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard refused: the text stays selectable
    }
  };
  return (
    <div className="metal-well relative rounded-md px-3 py-2 text-xs font-mono">
      <pre className="whitespace-pre-wrap break-all pr-8 select-all" style={{ color: 'var(--color-text)' }}>
        {code}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute top-1.5 right-1.5 p-1 rounded cursor-pointer"
        style={{ color: 'var(--color-text-tertiary)' }}
        title="Copy"
        aria-label="Copy"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}
