import type { FailedPod } from '../types';

export default function FailedPodsWarning({ failedPods }: { failedPods?: FailedPod[] }) {
  if (!failedPods || failedPods.length === 0) return null;

  return (
    <div className="klv-card border-amber-200 bg-amber-50 px-4 py-3 mb-4 text-xs text-amber-700">
      <p className="font-semibold mb-1">
        Could not read logs from {failedPods.length} pod{failedPods.length !== 1 ? 's' : ''}
      </p>
      <ul className="font-mono space-y-0.5 break-all">
        {failedPods.map((f) => (
          <li key={f.pod}>
            {f.pod}: {f.error}
          </li>
        ))}
      </ul>
    </div>
  );
}
