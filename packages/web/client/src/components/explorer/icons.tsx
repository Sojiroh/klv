interface IconProps {
  className?: string;
}

function Icon({ className = 'w-3.5 h-3.5', d }: IconProps & { d: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => <Icon {...p} d="M12 5v14M5 12h14" />;
export const MinusIcon = (p: IconProps) => <Icon {...p} d="M5 12h14" />;
export const XIcon = (p: IconProps) => <Icon {...p} d="M6 18L18 6M6 6l12 12" />;
export const ChevronRightIcon = (p: IconProps) => <Icon {...p} d="M9 5l7 7-7 7" />;
export const ChevronDownIcon = (p: IconProps) => <Icon {...p} d="M19 9l-7 7-7-7" />;
export const SearchIcon = (p: IconProps) => <Icon {...p} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />;
export const DownloadIcon = (p: IconProps) => <Icon {...p} d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3M12 4v12m0 0l-4-4m4 4l4-4" />;
export const ColumnsIcon = (p: IconProps) => <Icon {...p} d="M9 4v16M15 4v16M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />;
export const FilterIcon = (p: IconProps) => <Icon {...p} d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />;
export const ClockIcon = (p: IconProps) => <Icon {...p} d="M12 7v5l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />;
export const CopyIcon = (p: IconProps) => <Icon {...p} d="M8 8V6a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-2M6 8h8a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z" />;
export const ArrowRightIcon = (p: IconProps) => <Icon {...p} d="M14 5l7 7m0 0l-7 7m7-7H3" />;
export const TrashIcon = (p: IconProps) => <Icon {...p} d="M19 7l-1 12a2 2 0 01-2 2H8a2 2 0 01-2-2L5 7m5 4v6m4-6v6M9 7V4h6v3M4 7h16" />;
export const RefreshIcon = (p: IconProps) => <Icon {...p} d="M4 4v6h6M20 20v-6h-6M5.5 15A8 8 0 0018 17.5M18.5 9A8 8 0 006 6.5" />;
export const BookmarkIcon = (p: IconProps) => <Icon {...p} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z" />;
