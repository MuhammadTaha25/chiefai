export function SkeletonLine({ width = "100%" }: { width?: string }) {
  return (
    <div
      className="h-3 animate-pulse rounded-full"
      style={{ width, background: "#F1F3F7" }}
      aria-hidden
    />
  );
}

export function KpiSkeleton() {
  return (
    <div className="ns-card flex flex-col gap-3 p-5">
      <SkeletonLine width="40%" />
      <div className="h-7 w-24 animate-pulse rounded-md" style={{ background: "#F1F3F7" }} />
      <SkeletonLine width="60%" />
    </div>
  );
}

export function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="size-8 shrink-0 animate-pulse rounded-full" style={{ background: "#F1F3F7" }} />
      <div className="flex-1 space-y-2">
        <SkeletonLine width="45%" />
        <SkeletonLine width="25%" />
      </div>
    </div>
  );
}

export default SkeletonLine;
