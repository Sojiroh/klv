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
    <div className="flex items-center gap-4 mb-4">
      <select
        value={level}
        onChange={(e) => onLevelChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
      >
        <option value="">All levels</option>
        {levels.filter(Boolean).map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Search logs..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 max-w-xs"
      />

      <button
        onClick={onRawToggle}
        className={`px-3 py-1.5 text-sm rounded border ${
          showRaw ? 'border-cyan-500 text-cyan-400' : 'border-gray-700 text-gray-400'
        }`}
      >
        Raw JSON
      </button>
    </div>
  );
}
