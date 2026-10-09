import { useCallback, useState } from 'react';

function readStored<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? initial : (JSON.parse(raw) as T);
  } catch {
    return initial;
  }
}

/** `useState` backed by localStorage (JSON). Corrupt or unavailable storage falls back to `initial`. */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, initial));

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // almacenamiento no disponible o lleno: el valor solo vive en memoria
      }
    },
    [key],
  );

  return [value, update];
}
