import { useRef, useState } from 'react';
import { TIME_RANGES, resolveRange, type TimeRangeState } from '../../lib/time';
import { useDismiss } from '../../hooks/useDismiss';
import { ClockIcon } from './icons';

const pad2 = (n: number) => String(n).padStart(2, '0');

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatShort(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

interface Props {
  value: TimeRangeState;
  /** Reference "now" for resolving the custom editor's initial values. */
  now: number;
  onChange: (range: TimeRangeState) => void;
}

export default function TimeRangePicker({ value, now, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const isCustom = value.range === 'custom';

  useDismiss(popRef, open, () => setOpen(false));

  const openCustom = () => {
    const resolved = resolveRange(value, now);
    setFrom(toLocalInput(resolved.from));
    setTo(toLocalInput(resolved.to));
    setError(null);
    setOpen(true);
  };

  const applyCustom = () => {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      setError('Enter both dates');
      return;
    }
    if (fromMs >= toMs) {
      setError('"From" must be earlier than "to"');
      return;
    }
    setOpen(false);
    onChange({ range: 'custom', from: fromMs, to: toMs });
  };

  return (
    <div className="relative flex items-center gap-2" ref={popRef}>
      <div className="flex items-center rounded-lg border border-klv-border bg-klv-elevated p-0.5">
        <ClockIcon className="w-3.5 h-3.5 text-klv-text-muted mx-1.5" />
        {TIME_RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => {
              setOpen(false);
              onChange({ range: r.id });
            }}
            title={r.label}
            className={`px-2 py-1 text-xs font-mono rounded-md transition-colors ${
              value.range === r.id
                ? 'bg-klv-accent/15 text-klv-accent'
                : 'text-klv-text-muted hover:text-klv-text hover:bg-klv-border/40'
            }`}
          >
            {r.id}
          </button>
        ))}
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openCustom())}
          className={`px-2 py-1 text-xs font-mono rounded-md transition-colors ${
            isCustom || open
              ? 'bg-klv-accent/15 text-klv-accent'
              : 'text-klv-text-muted hover:text-klv-text hover:bg-klv-border/40'
          }`}
        >
          {isCustom && value.from !== undefined && value.to !== undefined
            ? `${formatShort(value.from)} → ${formatShort(value.to)}`
            : 'Custom'}
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[320px] klv-card bg-klv-elevated shadow-2xl shadow-black/50 z-40 p-4 space-y-3 animate-fade-in">
          <p className="klv-section-label">Custom range</p>
          <label className="block">
            <span className="text-[11px] text-klv-text-muted font-body">From</span>
            <input
              type="datetime-local"
              step={1}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="klv-input w-full font-mono text-xs mt-1 [color-scheme:dark]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-klv-text-muted font-body">To (exclusive)</span>
            <input
              type="datetime-local"
              step={1}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
              className="klv-input w-full font-mono text-xs mt-1 [color-scheme:dark]"
            />
          </label>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="klv-btn-secondary text-xs !px-3 !py-1.5" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="klv-btn-primary text-xs !px-3 !py-1.5" onClick={applyCustom}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
