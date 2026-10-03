import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <span className="grid size-10 place-items-center rounded-full" style={{ background: "#F1F3F7" }}>
        <Icon className="size-5" style={{ color: "#98A2B3" }} aria-hidden />
      </span>
      <p className="text-[14px] font-semibold" style={{ color: "#101828" }}>
        {title}
      </p>
      <p className="ns-body max-w-xs">{description}</p>
    </div>
  );
}

export default EmptyState;
