import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Histogram as HistogramData } from '../../lib/histogram';
import { NONE_GROUP, OTHER_GROUP } from '../../lib/histogram';
import { useElementWidth } from '../../hooks/useElementWidth';
import { formatMs, formatTick, levelConfig } from '../../utils/log-utils';

const GROUP_COLORS = [
  'text-blue-600',
  'text-violet-600',
  'text-emerald-600',
  'text-amber-600',
  'text-pink-600',
  'text-cyan-600',
  'text-orange-600',
  'text-indigo-600',
];

const CHART_HEIGHT = 72;
const AXIS_HEIGHT = 18;
const MIN_DRAG_PX = 5;
const MIN_ZOOM_MS = 1000;
const TICKS = 6;

function formatBucket(ms: number): string {
  if (ms >= 24 * 60 * 60_000) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms >= 60 * 60_000) return `${ms / (60 * 60_000)}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

interface Props {
  histogram: HistogramData;
  /** Drag-selection callback; omit to disable zooming. */
  onZoom?: (from: number, to: number) => void;
  /** Legend chip click (non-level grouping); omit to make the legend read-only. */
  onSelectGroup?: (value: string) => void;
}

export default function Histogram({ histogram, onZoom, onSelectGroup }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  const { from, to, bucketMs, buckets, groups, groupBy } = histogram;
  const groupColor = (group: string, index: number) =>
    groupBy === 'level'
      ? (levelConfig[group] ?? levelConfig.UNKNOWN).color
      : group === OTHER_GROUP || group === NONE_GROUP
        ? 'text-slate-400'
        : GROUP_COLORS[index % GROUP_COLORS.length];
  const groupTotals = new Map<string, number>();
  for (const bucket of buckets) {
    for (const [group, count] of Object.entries(bucket.counts)) groupTotals.set(group, (groupTotals.get(group) ?? 0) + count);
  }
  const span = Math.max(1, to - from);
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const toX = (ms: number) => Math.min(width, Math.max(0, ((ms - from) / span) * width));
  const toMs = (x: number) => from + (Math.min(width, Math.max(0, x)) / Math.max(1, width)) * span;
  const barWidth = Math.max(1, (bucketMs / span) * width - 1);

  useEffect(() => {
    if (!drag) return;
    const onUp = () => {
      const { x0, x1 } = drag;
      setDrag(null);
      if (!onZoom || Math.abs(x1 - x0) < MIN_DRAG_PX) return;
      const a = toMs(Math.min(x0, x1));
      const b = toMs(Math.max(x0, x1));
      if (b - a >= MIN_ZOOM_MS) onZoom(Math.round(a), Math.round(b));
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  });

  const localX = (e: ReactMouseEvent<HTMLDivElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;

  const handleMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const x = localX(e);
    if (drag) setDrag({ ...drag, x1: x });
    if (buckets.length === 0) return;
    const index = Math.floor((toMs(x) - buckets[0].start) / bucketMs);
    setHover(buckets[index] ? { index, x } : null);
  };

  const hovered = hover ? buckets[hover.index] : null;
  const ticks = Array.from({ length: TICKS }, (_, i) => from + (span * i) / (TICKS - 1));

  return (
    <div ref={ref} className="relative select-none">
      {width > 0 && (
        <div
          className={onZoom ? 'cursor-crosshair' : ''}
          onMouseDown={(e) => {
            if (!onZoom || e.button !== 0) return;
            const x = localX(e);
            setDrag({ x0: x, x1: x });
          }}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          <svg width={width} height={CHART_HEIGHT + AXIS_HEIGHT} role="img" aria-label="Log volume over time">
            {[0.5, 1].map((f) => (
              <line
                key={f}
                x1={0}
                x2={width}
                y1={CHART_HEIGHT - f * (CHART_HEIGHT - 4)}
                y2={CHART_HEIGHT - f * (CHART_HEIGHT - 4)}
                className="stroke-klv-border-subtle"
                strokeDasharray="2 4"
              />
            ))}
            <line x1={0} x2={width} y1={CHART_HEIGHT} y2={CHART_HEIGHT} className="stroke-klv-border" />

            {buckets.map((bucket, i) => {
              if (bucket.total === 0) return null;
              const x = toX(bucket.start);
              let y = CHART_HEIGHT;
              return (
                <g key={bucket.start} opacity={hover && hover.index !== i ? 0.55 : 1}>
                  {groups.map((group, gi) => {
                    const count = bucket.counts[group];
                    if (!count) return null;
                    const h = (count / max) * (CHART_HEIGHT - 4);
                    y -= h;
                    return (
                      <rect
                        key={group}
                        x={x}
                        y={y}
                        width={barWidth}
                        height={h}
                        fill="currentColor"
                        className={groupColor(group, gi)}
                      />
                    );
                  })}
                </g>
              );
            })}

            {drag && (
              <rect
                x={Math.min(drag.x0, drag.x1)}
                y={0}
                width={Math.abs(drag.x1 - drag.x0)}
                height={CHART_HEIGHT}
                className="fill-klv-accent/15 stroke-klv-accent/60"
              />
            )}

            {ticks.map((t, i) => (
              <text
                key={i}
                x={i === 0 ? 2 : i === TICKS - 1 ? width - 2 : toX(t)}
                y={CHART_HEIGHT + 13}
                textAnchor={i === 0 ? 'start' : i === TICKS - 1 ? 'end' : 'middle'}
                className="fill-klv-text-muted font-mono"
                fontSize={10}
              >
                {formatTick(t, span)}
              </text>
            ))}
            <text x={4} y={11} className="fill-klv-text-muted font-mono" fontSize={10}>
              {max.toLocaleString()}
            </text>
          </svg>
        </div>
      )}

      {hovered && hover && !drag && (
        <div
          className="pointer-events-none absolute z-20 top-0 min-w-[150px] klv-card bg-klv-surface shadow-xl shadow-slate-900/10 border border-klv-border px-3 py-2 text-[11px] font-mono"
          style={hover.x > width / 2 ? { right: width - hover.x + 12 } : { left: hover.x + 12 }}
        >
          <p className="text-klv-text-secondary">
            {formatMs(hovered.start, bucketMs >= 24 * 60 * 60_000 || span > 24 * 60 * 60_000).replace(/\.000$/, '')}
            <span className="text-klv-text-muted"> +{formatBucket(bucketMs)}</span>
          </p>
          <p className="text-klv-text mb-1">{hovered.total.toLocaleString()} logs</p>
          {groups
            .map((group, gi) => ({ group, gi }))
            .filter(({ group }) => (hovered.counts[group] ?? 0) > 0)
            .reverse()
            .map(({ group, gi }) => (
              <p key={group} className={`flex justify-between gap-4 ${groupColor(group, gi)}`}>
                <span>{group}</span>
                <span className="tabular-nums">{hovered.counts[group].toLocaleString()}</span>
              </p>
            ))}
        </div>
      )}

      {groupBy !== 'level' && groups.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pb-1 text-[11px] font-mono">
          {groups.map((group, gi) => {
            const clickable = !!onSelectGroup && group !== OTHER_GROUP && group !== NONE_GROUP;
            const content = (
              <>
                <span className={groupColor(group, gi)}>■</span> {group}
                <span className="text-klv-text-muted"> · {(groupTotals.get(group) ?? 0).toLocaleString()}</span>
              </>
            );
            return clickable ? (
              <button
                key={group}
                type="button"
                title="Filter by this value"
                className="text-klv-text-secondary hover:text-klv-text"
                onClick={() => onSelectGroup(group)}
              >
                {content}
              </button>
            ) : (
              <span key={group} className="text-klv-text-secondary">
                {content}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
