import type { LogPattern } from '../../lib/patterns';
import { LEVEL_ORDER, formatMs, levelConfig } from '../../utils/log-utils';

const MAX_ROWS = 300;

const PLACEHOLDER = /(<(?:uuid|ts|ip|email|hex|num)>|"<str>")/g;

function Signature({ text }: { text: string }) {
  return (
    <>
      {text.split(PLACEHOLDER).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="text-klv-accent/80 bg-klv-accent/10 rounded px-0.5">{part}</span>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface Props {
  patterns: LogPattern[];
  total: number;
  active: string | null;
  maxHeight: string;
  onSelect: (id: string | null) => void;
}

export default function PatternsTable({ patterns, total, active, maxHeight, onSelect }: Props) {
  if (patterns.length === 0) {
    return <div className="klv-card py-10 text-center text-sm text-klv-text-muted">No patterns</div>;
  }

  return (
    <div className="klv-card overflow-auto" style={{ maxHeight }}>
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-klv-surface">
          <tr className="border-b border-klv-border">
            <th className="py-2 px-3 text-right klv-section-label w-24">Count</th>
            <th className="py-2 px-3 text-left klv-section-label w-28">Levels</th>
            <th className="py-2 px-3 text-left klv-section-label">Pattern</th>
            <th className="py-2 px-3 text-right klv-section-label w-28">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-klv-border-subtle">
          {patterns.slice(0, MAX_ROWS).map((pattern) => {
            const isActive = pattern.id === active;
            return (
              <tr
                key={pattern.id}
                tabIndex={0}
                onClick={() => onSelect(isActive ? null : pattern.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(isActive ? null : pattern.id);
                  }
                }}
                title={pattern.sample.message}
                className={`cursor-pointer transition-colors focus:outline-none focus:bg-klv-elevated/60 ${
                  isActive ? 'bg-klv-accent/10' : 'hover:bg-klv-elevated/40'
                }`}
              >
                <td className="py-2 px-3 text-right font-mono align-top">
                  <span className="text-klv-text tabular-nums">{pattern.count.toLocaleString()}</span>
                  <span className="block text-[10px] text-klv-text-muted tabular-nums">
                    {total > 0 ? `${((pattern.count / total) * 100).toFixed(1)}%` : ''}
                  </span>
                </td>
                <td className="py-2 px-3 align-top">
                  <div className="flex h-1.5 w-24 rounded-full overflow-hidden bg-klv-border-subtle mt-1.5">
                    {LEVEL_ORDER.map((level) => {
                      const count = pattern.levels[level];
                      if (!count) return null;
                      return (
                        <span
                          key={level}
                          title={`${level}: ${count}`}
                          className={`h-full bg-current ${(levelConfig[level] ?? levelConfig.UNKNOWN).color}`}
                          style={{ width: `${(count / pattern.count) * 100}%` }}
                        />
                      );
                    })}
                  </div>
                </td>
                <td className="py-2 px-3 font-mono text-klv-text-secondary break-all">
                  <Signature text={pattern.signature} />
                </td>
                <td className="py-2 px-3 text-right font-mono text-klv-text-muted align-top tabular-nums whitespace-nowrap">
                  {pattern.lastSeen === null ? '--' : formatMs(pattern.lastSeen, true).replace(/\.\d{3}$/, '')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {patterns.length > MAX_ROWS && (
        <p className="px-3 py-2 text-[11px] text-klv-text-muted border-t border-klv-border-subtle">
          Showing the top {MAX_ROWS} of {patterns.length.toLocaleString()} patterns
        </p>
      )}
    </div>
  );
}
