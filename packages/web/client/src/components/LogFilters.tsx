interface Props {
  level: string;
  search: string;
  showRaw: boolean;
  onLevelChange: (level: string) => void;
  onSearchChange: (search: string) => void;
  onRawToggle: () => void;
}

const levels = ['', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

export default function LogFilters({ level, search, showRaw, onLevelChange, onSearchChange, onRawToggle }: Props) {
  return (
    <div className="flex items-center gap-3 mb-4 animate-fade-in">
      <select
        value={level}
        onChange={(e) => onLevelChange(e.target.value)}
        className="klv-select"
      >
        <option value="">All levels</option>
        {levels.filter(Boolean).map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>

      <div className="relative flex-1 max-w-xs">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-klv-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Filter logs..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="klv-input w-full pl-9"
        />
      </div>

      <button
        onClick={onRawToggle}
        className={`klv-btn text-xs ${
          showRaw
            ? 'bg-klv-accent/15 text-klv-accent border border-klv-accent/30'
            : 'bg-klv-elevated text-klv-text-muted border border-klv-border hover:text-klv-text-secondary'
        }`}
      >
        <span className="font-mono">{'{}'}</span> Raw
      </button>
    </div>
  );
}
