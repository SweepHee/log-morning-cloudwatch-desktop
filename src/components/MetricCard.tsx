import type { LucideIcon } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: number;
  description: string;
  icon: LucideIcon;
  tone: "neutral" | "error" | "warn" | "business";
  active?: boolean;
  onClick?: () => void;
}

export function MetricCard({
  label,
  value,
  description,
  icon: Icon,
  tone,
  active,
  onClick,
}: MetricCardProps) {
  return (
    <button
      className={`metric-card tone-${tone} ${active ? "is-active" : ""}`}
      type="button"
      onClick={onClick}
    >
      <span className="metric-icon">
        <Icon size={20} strokeWidth={2.15} />
      </span>
      <span className="metric-copy">
        <span className="metric-label">{label}</span>
        <strong>{value.toLocaleString()}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}
