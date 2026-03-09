import { useState } from 'react';
import { Link } from 'react-router-dom';

export interface ContainerGroup {
  container: string;
  podCount: number;
  statuses: string[];
  pods: { name: string; status: string; age: string }[];
}

const statusStyles: Record<string, { dot: string; text: string }> = {
  Running: { dot: 'bg-emerald-400', text: 'text-emerald-400' },
  Pending: { dot: 'bg-amber-400', text: 'text-amber-400' },
  Succeeded: { dot: 'bg-sky-400', text: 'text-sky-400' },
  Failed: { dot: 'bg-red-400', text: 'text-red-400' },
  Unknown: { dot: 'bg-zinc-500', text: 'text-zinc-500' },
};

function StatusBadge({ status }: { status: string }) {
  const s = statusStyles[status] ?? statusStyles.Unknown;
  return (
    <span className={`klv-badge border border-klv-border ${s.text} bg-klv-elevated`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} mr-1.5`} />
      {status}
    </span>
  );
}

export default function ContainerTable({ groups, namespace }: { groups: ContainerGroup[]; namespace: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (groups.length === 0) {
    return (
      <div className="klv-card px-6 py-12 text-center">
        <p className="text-klv-text-muted font-body">No containers found</p>
      </div>
    );
  }

  const toggle = (container: string) =>
    setExpanded((prev) => ({ ...prev, [container]: !prev[container] }));

  return (
    <div className="klv-card overflow-hidden animate-slide-up">
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="border-b border-klv-border bg-klv-surface">
            <th className="py-3 px-4 w-10"></th>
            <th className="py-3 px-4 text-left klv-section-label">Container</th>
            <th className="py-3 px-4 text-left klv-section-label">Pods</th>
            <th className="py-3 px-4 text-left klv-section-label">Status</th>
            <th className="py-3 px-4 text-right klv-section-label">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-klv-border-subtle">
          {groups.map((g) => (
            <ContainerRow
              key={g.container}
              group={g}
              namespace={namespace}
              isExpanded={!!expanded[g.container]}
              onToggle={() => toggle(g.container)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContainerRow({
  group: g,
  namespace,
  isExpanded,
  onToggle,
}: {
  group: ContainerGroup;
  namespace: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="group hover:bg-klv-surface/50 transition-colors duration-150">
        <td className="py-3 px-4">
          <button
            onClick={onToggle}
            className="w-6 h-6 flex items-center justify-center rounded
                       text-klv-text-muted hover:text-klv-text hover:bg-klv-elevated
                       transition-all duration-200"
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </td>
        <td className="py-3 px-4">
          <span className="font-mono text-sm text-klv-text">{g.container}</span>
        </td>
        <td className="py-3 px-4">
          <span className="font-mono text-klv-text-secondary">{g.podCount}</span>
        </td>
        <td className="py-3 px-4">
          <div className="flex flex-wrap gap-1.5">
            {g.statuses.map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
          </div>
        </td>
        <td className="py-3 px-4 text-right">
          <Link
            to={`/logs/${namespace}/container/${encodeURIComponent(g.container)}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-klv-accent hover:text-klv-accent-hover transition-colors"
          >
            View Logs
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </td>
      </tr>
      {isExpanded &&
        g.pods.map((pod) => (
          <tr key={pod.name} className="bg-klv-base/50">
            <td className="py-2 px-4"></td>
            <td className="py-2 px-4 pl-10">
              <span className="font-mono text-xs text-klv-text-muted">{pod.name}</span>
            </td>
            <td className="py-2 px-4"></td>
            <td className="py-2 px-4">
              <StatusBadge status={pod.status} />
            </td>
            <td className="py-2 px-4 text-right">
              <span className="text-xs text-klv-text-muted">{pod.age}</span>
            </td>
          </tr>
        ))}
    </>
  );
}
