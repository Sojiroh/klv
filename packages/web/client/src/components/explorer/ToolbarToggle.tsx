import type { ReactNode } from 'react';

interface Props {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}

export default function ToolbarToggle({ active, onClick, title, children }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`klv-btn text-xs !px-3 !py-1.5 inline-flex items-center gap-1.5 border ${
        active
          ? 'bg-klv-accent/15 text-klv-accent border-klv-accent/30'
          : 'bg-klv-elevated text-klv-text-muted border-klv-border hover:text-klv-text-secondary'
      }`}
    >
      {children}
    </button>
  );
}
