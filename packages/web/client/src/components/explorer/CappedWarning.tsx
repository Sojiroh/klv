interface Props {
  /** Pods (or pod/container pairs) that returned at least `tail` lines. */
  capped: string[];
  /** Pods (or pod/container pairs) whose oldest lines were dropped to fit the 32 MB response limit. */
  trimmed?: string[];
  tail: number;
}

function NameList({ names }: { names: string[] }) {
  return (
    <p className="font-mono mt-1 break-all text-amber-700">
      {names.slice(0, 8).join(', ')}
      {names.length > 8 && ` … +${names.length - 8}`}
    </p>
  );
}

export default function CappedWarning({ capped, trimmed = [], tail }: Props) {
  if (capped.length === 0 && trimmed.length === 0) return null;
  return (
    <div className="klv-card border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
      {capped.length > 0 && (
        <div>
          <p className="font-semibold mb-1">
            {capped.length} pod{capped.length !== 1 ? 's' : ''} returned the maximum of {tail.toLocaleString()} lines
          </p>
          <p className="text-amber-700">
            Older lines in the selected range may be missing. Increase the tail or narrow the time range.
          </p>
          <NameList names={capped} />
        </div>
      )}
      {trimmed.length > 0 && (
        <div className={capped.length > 0 ? 'mt-3' : undefined}>
          <p className="font-semibold mb-1">
            {trimmed.length} pod{trimmed.length !== 1 ? 's' : ''} returned more than 32 MB of logs
          </p>
          <p className="text-amber-700">
            Only the most recent lines were kept. Narrow the time range or filter by container; use History for long ranges.
          </p>
          <NameList names={trimmed} />
        </div>
      )}
    </div>
  );
}
