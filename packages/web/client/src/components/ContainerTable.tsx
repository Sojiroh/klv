import { useState } from 'react';
import { Link } from 'react-router-dom';
import { statusStyles } from '../utils/log-utils';

export interface ContainerGroup {
  container: string;
  podCount: number;
  restarts: number;
  statuses: string[];
  pods: { name: string; status: string; age: string; restarts: number }[];
}

function RestartsBadge({ count }: { count: number }) {
  return (
    <span
      className={`klv-badge border ${
        count > 0
          ? 'text-amber-700 bg-amber-50 border-amber-200'
          : 'text-klv-text-muted bg-klv-elevated border-klv-border'
      }`}
    >
      {count}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = statusStyles[status] ?? statusStyles.Unknown;
  return (
    <span className={`klv-badge border border-klv-border ${s.text} bg-klv-elevated`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} mr-1.5`} />
      {status}
    </span>
  );
}

interface Props {
  groups: ContainerGroup[];
  namespace: string;
  // Resolves once handled; the caller reports failures
  onDeletePod: (pod: string) => Promise<void>;
}

export default function ContainerTable({ groups, namespace, onDeletePod }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (groups.length === 0) {
    return (
      <div className="klv-card px-6 py-12 text-center">
        <p className="text-klv-text-muted font-body">No containers found</p>
      </div>
    );
  }

  const toggle = (container: string, isOpen: boolean) =>
    setExpanded((prev) => ({ ...prev, [container]: !isOpen }));

  return (
    <div className="klv-card overflow-hidden animate-slide-up">
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="border-b border-klv-border bg-klv-surface">
            <th className="py-3 px-4 w-10"></th>
            <th className="py-3 px-4 text-left klv-section-label">Container</th>
            <th className="py-3 px-4 text-left klv-section-label">Pods</th>
            <th className="py-3 px-4 text-left klv-section-label">Status</th>
            <th className="py-3 px-4 text-left klv-section-label">Restarts</th>
            {/* Wide enough for the inline delete confirmation, so columns don't shift when it opens */}
            <th className="py-3 px-4 text-right klv-section-label w-[260px]">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-klv-border-subtle">
          {groups.map((g) => (
            <ContainerRow
              key={g.container}
              group={g}
              namespace={namespace}
              onDeletePod={(pod) => {
                // Pin the group open: its default (open while it has restarts) may flip once the pod is gone
                setExpanded((prev) => ({ ...prev, [g.container]: true }));
                return onDeletePod(pod);
              }}
              isExpanded={expanded[g.container] ?? g.restarts > 0}
              onToggle={() => toggle(g.container, expanded[g.container] ?? g.restarts > 0)}
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
  onDeletePod,
  isExpanded,
  onToggle,
}: {
  group: ContainerGroup;
  namespace: string;
  onDeletePod: (pod: string) => Promise<void>;
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
        <td className="py-3 px-4">
          <RestartsBadge count={g.restarts} />
        </td>
        <td className="py-3 px-4 text-right">
          <Link
            to={`/logs/${encodeURIComponent(namespace)}/container/${encodeURIComponent(g.container)}`}
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
              <Link
                to={`/logs/${encodeURIComponent(namespace)}/${encodeURIComponent(pod.name)}?container=${encodeURIComponent(g.container)}`}
                className="font-mono text-xs text-klv-text-muted hover:text-klv-accent transition-colors"
              >
                {pod.name}
              </Link>
            </td>
            <td className="py-2 px-4"></td>
            <td className="py-2 px-4">
              <StatusBadge status={pod.status} />
            </td>
            <td className="py-2 px-4">
              {pod.restarts > 0 ? (
                <div className="flex items-center gap-3">
                  <RestartsBadge count={pod.restarts} />
                  <Link
                    to={`/logs/${encodeURIComponent(namespace)}/${encodeURIComponent(pod.name)}?container=${encodeURIComponent(g.container)}&previous=true`}
                    className="text-xs font-medium text-amber-600 hover:text-amber-700 transition-colors"
                  >
                    Previous logs
                  </Link>
                </div>
              ) : (
                <RestartsBadge count={0} />
              )}
            </td>
            <td className="py-2 px-4">
              <div className="flex items-center justify-end gap-3">
                <span className="text-xs text-klv-text-muted">{pod.age}</span>
                <DeletePodAction pod={pod} onDelete={onDeletePod} />
              </div>
            </td>
          </tr>
        ))}
    </>
  );
}

function TrashIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
      />
    </svg>
  );
}

function DeletePodAction({
  pod,
  onDelete,
}: {
  pod: { name: string; status: string };
  onDelete: (pod: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    await onDelete(pod.name);
    setDeleting(false);
    setConfirming(false);
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-klv-text-secondary whitespace-nowrap">Delete pod?</span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className="klv-btn-secondary !px-2.5 !py-1 text-xs"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={deleting}
          className="klv-btn-danger !px-2.5 !py-1 text-xs whitespace-nowrap"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    );
  }

  const terminating = pod.status === 'Terminating';
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      disabled={terminating}
      title={terminating
        ? 'Already terminating'
        : 'Delete pod (kubectl delete pod); its controller, if any, creates a replacement'}
      className="w-6 h-6 flex items-center justify-center rounded text-klv-text-muted
                 hover:text-red-600 hover:bg-red-50 transition-colors
                 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-klv-text-muted"
    >
      <TrashIcon />
    </button>
  );
}
