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
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const hasKeys = (value: Record<string, unknown>) => Object.keys(value).length > 0;

const flattenTelemetryData = (value: unknown) => {
  const data = asRecord(value);
  const nestedGpu = asRecord(data.gpu);
  return hasKeys(nestedGpu) ? { ...data, ...nestedGpu } : data;
};

const numberValue = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const booleanValue = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'ok', 'healthy', 'up', 'online'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'error', 'failed', 'down', 'offline', 'unavailable'].includes(normalized)) {
      return false;
    }
  }
  return null;
};

const stringValue = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const firstNumber = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = stringValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

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
  const ok = booleanValue(data.ok);
  const status = stringValue(data.status)?.toLowerCase();

  if (entry.last_error) return 'unavailable';
  if (entry.stale) return 'stale';
  if (ok === true || status === 'ok' || status === 'healthy' || status === 'up' || status === 'online') return 'healthy';
  if (ok === false) return 'unavailable';
  return status ?? 'unknown';
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
  const gpu = flattenTelemetryData(service.gpu.data);
  const state = healthState(service.health);
  const name = firstString(gpu.name, gpu.gpu_name, gpu.gpuName, gpu.product_name, gpu.productName);
  const driverVersion = firstString(gpu.driver_version, gpu.driverVersion, gpu.driver);
  const temp = firstNumber(gpu.temperature_gpu_c, gpu.temperature_c, gpu.temperature);
  const memoryUsed = firstNumber(gpu.memory_used_mib, gpu.memoryUsedMib, gpu.memory_used_mb, gpu.memoryUsedMb);
  const memoryTotal = firstNumber(gpu.memory_total_mib, gpu.memoryTotalMib, gpu.memory_total_mb, gpu.memoryTotalMb);
  const reportedMemoryFree = firstNumber(gpu.memory_free_mib, gpu.memoryFreeMib, gpu.memory_free_mb, gpu.memoryFreeMb);
  const memoryFree =
    reportedMemoryFree ?? (memoryTotal !== null && memoryUsed !== null ? Math.max(0, memoryTotal - memoryUsed) : null);
  const powerDraw = firstNumber(gpu.power_draw_w, gpu.powerDrawW, gpu.power_draw, gpu.powerDraw);
  const powerLimit = firstNumber(gpu.power_limit_w, gpu.powerLimitW, gpu.power_limit, gpu.powerLimit);
  const fan = firstNumber(gpu.fan_speed_percent, gpu.fanSpeedPercent, gpu.fan_percent, gpu.fanPercent);
  const util = firstNumber(
    gpu.utilization_gpu_percent,
    gpu.utilizationGpuPercent,
    gpu.gpu_utilization_percent,
    gpu.gpuUtilizationPercent,
    gpu.utilization_percent,
    gpu.utilizationPercent
  );
  const gpuStatus = stringValue(gpu.status)?.toLowerCase() ?? null;
  const gpuStatusIsProblem = gpuStatus !== null && !['ok', 'healthy', 'up', 'online'].includes(gpuStatus);
  const gpuSummary = `${compactGpuName(name)} · ${formatTemperature(temp)}`;
  const metadata = [
    driverVersion ? `Driver ${driverVersion}` : null,
    memoryFree !== null ? `${formatMemoryGiB(memoryFree)} GiB free` : null
  ].filter((item): item is string => Boolean(item));

  return (
    <article className="status-card" aria-label={`${title} ${gpuSummary} status ${state}`}>
      <div className="status-card-header">
        <div>
          <h3>
            {title} <span>· {compactGpuName(name)}</span> {temp !== null && <span>· {fixed(temp)}°C</span>}
          </h3>
          <p className="status-gpu-line">{metadata.length > 0 ? metadata.join(' · ') : 'GPU telemetry unavailable'}</p>
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
        label="Free VRAM"
        displayText={memoryFree !== null ? `${formatMemoryGiB(memoryFree)} GiB` : 'n/a'}
        percentage={ratioPercentage(memoryFree, memoryTotal)}
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

      {(service.health.last_error || service.gpu.last_error || service.health.stale || service.gpu.stale || gpuStatusIsProblem) && (
        <div className="status-footnote">
          {service.health.last_error && <span>Health: {service.health.last_error}</span>}
          {service.gpu.last_error && <span>GPU: {service.gpu.last_error}</span>}
          {gpuStatusIsProblem && <span>GPU status: {gpuStatus}</span>}
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
