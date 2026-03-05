interface Props {
  contexts: string[];
  current: string;
  onSwitch: (name: string) => void;
  namespaces: string[];
  namespace: string;
  onNamespaceChange: (ns: string) => void;
}

export default function ContextSelector({
  contexts, current, onSwitch,
  namespaces, namespace, onNamespaceChange,
}: Props) {
  return (
    <div className="flex items-center gap-4 mb-6">
      <label className="text-sm text-gray-400">Context:</label>
      <select
        value={current}
        onChange={(e) => onSwitch(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
      >
        {contexts.map((ctx) => (
          <option key={ctx} value={ctx}>{ctx}</option>
        ))}
      </select>

      <label className="text-sm text-gray-400 ml-4">Namespace:</label>
      <select
        value={namespace}
        onChange={(e) => onNamespaceChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
      >
        {namespaces.map((ns) => (
          <option key={ns} value={ns}>{ns}</option>
        ))}
      </select>
    </div>
  );
}
