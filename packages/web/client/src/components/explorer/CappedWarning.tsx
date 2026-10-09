interface Props {
  /** Pods (or pod/container pairs) that returned at least `tail` lines. */
  capped: string[];
  tail: number;
}

export default function CappedWarning({ capped, tail }: Props) {
  if (capped.length === 0) return null;
  return (
    <div className="klv-card border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-400">
      <p className="font-semibold mb-1">
        {capped.length} pod{capped.length !== 1 ? 's' : ''} returned the maximum of {tail.toLocaleString()} lines
      </p>
      <p className="text-amber-400/80">
        Older lines in the selected range may be missing. Increase the tail or narrow the time range.
      </p>
      <p className="font-mono mt-1 break-all text-amber-400/70">
        {capped.slice(0, 8).join(', ')}
        {capped.length > 8 && ` … +${capped.length - 8}`}
      </p>
    </div>
  );
}
