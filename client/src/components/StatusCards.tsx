import type { GatewayStatus, ServiceTelemetryStatus, TelemetryEntry } from '../lib/types.js';

interface StatusCardsProps {
  status: GatewayStatus | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

interface MetricBarProps {
  label: string;
  displayText: string;
  percentage: number | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const numberValue = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const clampPercentage = (value: number) => Math.min(100, Math.max(0, value));

const ratioPercentage = (value: unknown, max: unknown) => {
  const current = numberValue(value);
  const total = numberValue(max);
  if (current === null || total === null || total <= 0) return null;
  return clampPercentage((current / total) * 100);
};

const fixed = (value: number, digits = 0) => value.toFixed(digits).replace(/\.0$/, '');

const valueText = (value: unknown, fallback = 'n/a') => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : fixed(value, 1);
  return String(value);
};

const compactGpuName = (name: unknown) =>
  valueText(name, 'GPU unavailable')
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^GeForce\s+/i, '');

const formatTemperature = (value: number | null) => (value === null ? '--°C' : `${fixed(value)}°C`);

const formatMemoryGiB = (value: number) => (value / 1024).toFixed(1);

const healthState = (entry: TelemetryEntry) => {
  const data = asRecord(entry.data);
  const status = valueText(data.status, entry.stale ? 'stale' : 'unknown').toLowerCase();
  if (entry.last_error) return 'unavailable';
  if (entry.stale) return 'stale';
  if (status === 'ok') return 'healthy';
  return status;
};

const serviceState = (service: ServiceTelemetryStatus | null | undefined) =>
  service ? healthState(service.health) : 'loading';

const MetricBar = ({ label, displayText, percentage }: MetricBarProps) => (
  <div className="gpu-metric">
    <div className="gpu-metric-label">
      <span>{label}</span>
      <strong>{displayText}</strong>
    </div>
    <div className={`gpu-bar ${percentage === null ? 'unknown' : ''}`} aria-hidden="true">
      <span style={{ width: `${percentage ?? 0}%` }} />
    </div>
  </div>
);

const StatusPill = ({ label, state }: { label: string; state: string }) => (
  <span className={`status-pill ${state === 'healthy' ? 'ok' : state === 'stale' ? 'stale' : 'warn'}`}>
    <span aria-hidden="true" />
    {label}: {state}
  </span>
);

const StatusCard = ({ title, service }: { title: string; service: ServiceTelemetryStatus }) => {
  const gpu = asRecord(service.gpu.data);
  const state = healthState(service.health);
  const temp = numberValue(gpu.temperature_gpu_c);
  const memoryUsed = numberValue(gpu.memory_used_mib);
  const memoryTotal = numberValue(gpu.memory_total_mib);
  const powerDraw = numberValue(gpu.power_draw_w);
  const powerLimit = numberValue(gpu.power_limit_w);
  const fan = numberValue(gpu.fan_speed_percent);
  const util = numberValue(gpu.utilization_gpu_percent);
  const gpuSummary = `${compactGpuName(gpu.name)} · ${formatTemperature(temp)}`;

  return (
    <article className="status-card" aria-label={`${title} ${gpuSummary} status ${state}`}>
      <div className="status-card-header">
        <div>
          <h3>
            {title} <span>· {compactGpuName(gpu.name)}</span> {temp !== null && <span>· {fixed(temp)}°C</span>}
          </h3>
        </div>
        <span className={`badge ${state === 'healthy' ? 'ok' : state === 'stale' ? 'stale' : 'warn'}`}>{state}</span>
      </div>

      <MetricBar
        label="VRAM"
        displayText={
          memoryUsed !== null && memoryTotal !== null
            ? `${formatMemoryGiB(memoryUsed)} / ${formatMemoryGiB(memoryTotal)} GiB`
            : 'n/a'
        }
        percentage={ratioPercentage(memoryUsed, memoryTotal)}
      />
      <MetricBar
        label="Power"
        displayText={powerDraw !== null && powerLimit !== null ? `${fixed(powerDraw, 1)} / ${fixed(powerLimit, 1)} W` : 'n/a'}
        percentage={ratioPercentage(powerDraw, powerLimit)}
      />
      <MetricBar
        label="Fan"
        displayText={fan !== null ? `${fixed(fan)}%` : 'n/a'}
        percentage={fan !== null ? clampPercentage(fan) : null}
      />
      <MetricBar
        label="Util"
        displayText={util !== null ? `${fixed(util)}%` : 'n/a'}
        percentage={util !== null ? clampPercentage(util) : null}
      />

      {(service.health.last_error || service.gpu.last_error || service.health.stale || service.gpu.stale) && (
        <div className="status-footnote">
          {service.health.last_error && <span>Health: {service.health.last_error}</span>}
          {service.gpu.last_error && <span>GPU: {service.gpu.last_error}</span>}
          {(service.health.stale || service.gpu.stale) && <span>Telemetry stale</span>}
        </div>
      )}
    </article>
  );
};

export const StatusCards = ({ status, collapsed, onToggleCollapsed }: StatusCardsProps) => (
  <section className={`status-panel ${collapsed ? 'collapsed' : ''}`} aria-label="Local AI service status">
    <div className="status-panel-header">
      <div className="status-panel-title">
        <span className="sidebar-label">System Health</span>
        <div className="status-summary" aria-label="Service health summary">
          <StatusPill label="LLM" state={serviceState(status?.llm)} />
          <StatusPill label="Voice" state={serviceState(status?.voice)} />
        </div>
      </div>
      <button
        className="status-toggle"
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand system health' : 'Collapse system health'}
        title={collapsed ? 'Expand system health' : 'Collapse system health'}
      >
        {collapsed ? 'Show' : 'Hide'}
      </button>
    </div>

    {!collapsed && (
      <div className="status-row">
        {!status && <article className="status-card skeleton">Loading service status...</article>}
        {status && (
          <>
            <StatusCard title="local-ai-llm" service={status.llm} />
            <StatusCard title="local-ai-voice" service={status.voice} />
          </>
        )}
      </div>
    )}
  </section>
);
