interface Props {
  namespaces: string[];
  namespace: string;
  onChange: (ns: string) => void;
}

export default function NamespaceSelector({ namespaces, namespace, onChange }: Props) {
  return (
    <div className="flex items-center gap-2 mb-8 animate-slide-up">
      <span className="klv-section-label">Namespace</span>
      <select
        value={namespace}
        onChange={(e) => onChange(e.target.value)}
        className="klv-select"
      >
        {namespaces.map((ns) => (
          <option key={ns} value={ns}>{ns}</option>
        ))}
      </select>
    </div>
  );
}
