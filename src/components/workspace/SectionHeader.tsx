import type { ReactNode } from "react";

export function SectionHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-5 pb-3">
      <div>
        {eyebrow && <p className="ns-label mb-1">{eyebrow}</p>}
        <h3 className="ns-section-title">{title}</h3>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export default SectionHeader;
