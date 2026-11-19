interface Props {
  contexts: string[];
  current: string;
  onSwitch: (name: string) => void;
}

// Selector de la barra superior: el contexto es global y cambiarlo recarga la vista actual
export default function ContextSelector({ contexts, current, onSwitch }: Props) {
  return (
    <label className="ml-auto pl-4 flex items-center gap-2 min-w-0">
      <span className="klv-section-label !text-white/50">Context</span>
      <select
        value={current}
        onChange={(e) => onSwitch(e.target.value)}
        title={current}
        className="klv-select !py-1 min-w-0 max-w-[18rem] text-xs font-mono text-white
                   bg-klv-nav-hover border-white/15 hover:border-white/30 focus:border-klv-accent-hover"
      >
        {contexts.map((ctx) => (
          <option key={ctx} value={ctx}>{ctx}</option>
        ))}
      </select>
    </label>
  );
}
