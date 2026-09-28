export default function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel panel-body">
      <p className="type-micro text-ink-tertiary">{label}</p>
      <p className="metric mt-2">{value}</p>
    </div>
  );
}
