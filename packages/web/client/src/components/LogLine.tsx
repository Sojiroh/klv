import { type ParsedLog } from '../types';
import { formatTime, levelConfig, prettyRaw } from '../utils/log-utils';

export default function LogLine({ log, showRaw, onClick, showPodName = false }: { log: ParsedLog; showRaw: boolean; onClick?: (log: ParsedLog) => void; showPodName?: boolean }) {
  const cfg = levelConfig[log.level] ?? levelConfig.UNKNOWN;

  if (showRaw) {
    return (
      <pre
        className={`text-xs text-klv-text-secondary font-mono whitespace-pre-wrap px-3 py-1
                    border-l-2 border-transparent hover:border-klv-accent/30
                    ${onClick ? 'cursor-pointer hover:bg-klv-elevated/50' : ''} transition-colors duration-100`}
        onClick={() => onClick?.(log)}
      >
        {log.isJson ? prettyRaw(log.raw) : log.raw}
      </pre>
    );
  }

  return (
    <div
      className={`font-mono text-xs flex items-start gap-2 px-3 py-[5px]
                  border-l-2 border-transparent hover:border-klv-accent/40 hover:bg-klv-elevated/40
                  ${onClick ? 'cursor-pointer' : ''} transition-all duration-100 group`}
      onClick={() => onClick?.(log)}
    >
      {/* Timestamp */}
      <span className="text-klv-text-muted shrink-0 tabular-nums">{formatTime(log.timestamp)}</span>

      {/* Level badge */}
      <span className={`shrink-0 inline-flex items-center gap-1 w-[58px] ${cfg.color}`}>
        <span className="text-[10px]">{cfg.icon}</span>
        <span>{log.level.padEnd(5)}</span>
      </span>

      {/* Pod name (aggregated mode) */}
      {showPodName && log.podName && (
        <span className="text-violet-400/80 shrink-0 truncate max-w-[14ch]" title={log.podName}>
          [{log.podName.slice(-8)}]
        </span>
      )}

      {/* Service */}
      {log.service && (
        <span className="text-sky-400/70 shrink-0">{log.service}</span>
      )}

      {/* Message */}
      <span className={`truncate ${log.level === 'ERROR' || log.level === 'FATAL' ? 'text-red-300' : 'text-klv-text-secondary group-hover:text-klv-text'} transition-colors`}>
        {log.message}
      </span>
    </div>
  );
}
