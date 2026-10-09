import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string;
  onCommit: (value: string) => void;
  delayMs?: number;
}

/** Text input that commits after a typing pause, on Enter, or on blur. */
export default function DebouncedInput({ value, onCommit, delayMs = 400, className, onBlur, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);

  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  const commit = (next: string) => {
    if (next === committed.current) return;
    committed.current = next;
    onCommit(next);
  };

  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => commit(draft), delayMs);
    return () => clearTimeout(timer);
  });

  return (
    <input
      {...rest}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        commit(draft);
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(draft);
        onKeyDown?.(e);
      }}
      className={className}
    />
  );
}
