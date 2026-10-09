import { TAIL_OPTIONS, type ExplorerParams } from '../../hooks/useExplorerParams';
import ToolbarToggle from './ToolbarToggle';
import { RefreshIcon } from './icons';

interface Props {
  params: ExplorerParams;
  loading: boolean;
  onRefresh: () => void;
  /** Label of the line limit: `Tail` for kubelet pages, `Page` for history. */
  limitLabel?: string;
  /** History has no previous-container concept. */
  showPrevious?: boolean;
}

export default function LoadControls({ params, loading, onRefresh, limitLabel = 'Tail', showPrevious = true }: Props) {
  return (
    <>
      <label className="flex items-center gap-1.5">
        <span className="klv-section-label">{limitLabel}</span>
        <select
          value={params.tail}
          onChange={(e) => params.setTail(Number(e.target.value))}
          className="klv-select !py-1 text-xs font-mono"
        >
          {TAIL_OPTIONS.map((n) => (
            <option key={n} value={n}>{n.toLocaleString()}</option>
          ))}
        </select>
      </label>
      {showPrevious && (
        <ToolbarToggle
          active={params.previous}
          onClick={() => params.setPrevious(!params.previous)}
          title="Logs of the previous (crashed / restarted) container instance"
        >
          Previous
        </ToolbarToggle>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title="Reload"
        className="klv-btn-secondary !px-2.5 !py-1.5"
      >
        <RefreshIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </>
  );
}
