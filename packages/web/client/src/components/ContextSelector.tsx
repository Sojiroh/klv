interface Props {
  contexts: string[];
  current: string;
  onSwitch: (name: string) => void;
  namespaces: string[] | null;
  namespace: string | null;
  onNamespaceChange: (ns: string) => void;
}

export default function ContextSelector({
  contexts, current, onSwitch,
  namespaces, namespace, onNamespaceChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-6 mb-8 animate-slide-up">
      <div className="flex items-center gap-2">
        <span className="klv-section-label">Context</span>
        <select
          value={current}
          onChange={(e) => onSwitch(e.target.value)}
          className="klv-select"
        >
          {contexts.map((ctx) => (
            <option key={ctx} value={ctx}>{ctx}</option>
          ))}
        </select>
      </div>

      {namespaces && namespace && (
        <>
          <div className="w-px h-6 bg-klv-border hidden sm:block" />

          <div className="flex items-center gap-2">
            <span className="klv-section-label">Namespace</span>
            <select
              value={namespace}
              onChange={(e) => onNamespaceChange(e.target.value)}
              className="klv-select"
            >
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );
}
