import { useRef, useState } from 'react';
import type { ColumnId } from '../../lib/columns';
import { logsToCsv, logsToJson, saveFile } from '../../lib/export';
import { errorMessage } from '../../lib/api';
import { useDismiss } from '../../hooks/useDismiss';
import type { ParsedLog } from '../../types';
import { DownloadIcon } from './icons';

interface Props {
  logs: ParsedLog[];
  columns: ColumnId[];
  /** File name prefix, e.g. `logs-payments`. */
  name: string;
}

export default function ExportMenu({ logs, columns, name }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const run = async (format: 'csv' | 'json') => {
    setOpen(false);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `${name}-${stamp}.${format}`;
    try {
      const contents = format === 'csv' ? logsToCsv(logs, columns) : logsToJson(logs);
      const saved = await saveFile(fileName, contents, format === 'csv' ? 'text/csv' : 'application/json');
      if (saved) setStatus({ ok: true, text: `Saved ${saved}` });
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) });
    }
    setTimeout(() => setStatus(null), 6000);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={logs.length === 0}
        onClick={() => setOpen((v) => !v)}
        className="klv-btn text-xs !px-3 !py-1.5 inline-flex items-center gap-1.5 border bg-klv-elevated text-klv-text-muted border-klv-border hover:text-klv-text-secondary"
      >
        <DownloadIcon />
        Export
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 klv-card bg-klv-surface border border-klv-border shadow-xl shadow-slate-900/10 z-40 py-1 animate-fade-in">
          <p className="px-3 py-1.5 text-[10px] text-klv-text-muted font-mono">{logs.length.toLocaleString()} filtered logs</p>
          <button
            type="button"
            onClick={() => void run('csv')}
            className="w-full text-left px-3 py-1.5 text-xs text-klv-text-secondary hover:bg-klv-border/40 hover:text-klv-text"
          >
            CSV <span className="text-klv-text-muted">· current columns</span>
          </button>
          <button
            type="button"
            onClick={() => void run('json')}
            className="w-full text-left px-3 py-1.5 text-xs text-klv-text-secondary hover:bg-klv-border/40 hover:text-klv-text"
          >
            JSON <span className="text-klv-text-muted">· full records</span>
          </button>
        </div>
      )}

      {status && (
        <div
          className={`absolute right-0 top-full mt-2 z-30 max-w-[360px] klv-card px-3 py-2 text-[11px] font-mono break-all animate-fade-in ${
            status.ok ? 'text-emerald-600 border-emerald-200 bg-emerald-50' : 'text-red-600 border-red-200 bg-red-50'
          }`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
