import { useId } from 'react';
import type {
  GatewayStatus,
  HealthStatusState,
  NormalizedGpuHealth,
  ServiceTelemetryStatus,
  TelemetryEntry
} from '../lib/types.js';

interface StatusCardsProps {
  status: GatewayStatus | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

interface MetricBarProps {
  label: string;
  displayText: string;
  percentage: number | null;
  variant?: 'default' | 'temperature';
}

interface DetailRow {
  label: string;
  value: string;
}

const OK_STATUSES = new Set(['ok', 'healthy', 'up', 'online', 'available', 'true']);
const PROBLEM_STATUSES = new Set(['error', 'failed', 'down', 'offline', 'unavailable', 'false']);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const hasKeys = (value: Record<string, unknown>) => Object.keys(value).length > 0;

const flattenTelemetryData = (value: unknown) => {
  const data = asRecord(value);
  const nestedGpu = asRecord(data.gpu);
  return hasKeys(nestedGpu) ? { ...data, ...nestedGpu } : data;
};

const recordsFromArray = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  return value.map(asRecord).filter(hasKeys);
};

const gpuRecordsFromTelemetry = (value: unknown) => {
  const data = asRecord(value);
  if (!hasKeys(data)) return [];

  const gpus = recordsFromArray(data.gpus);
  if (gpus) return gpus;

  const devices = recordsFromArray(data.devices);
  if (devices) return devices;

  return [flattenTelemetryData(data)].filter(hasKeys);
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
    if (OK_STATUSES.has(normalized) || ['1', 'yes', 'y'].includes(normalized)) return true;
    if (PROBLEM_STATUSES.has(normalized) || ['0', 'no', 'n'].includes(normalized)) return false;
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

const optionalNumber = (...values: unknown[]) => firstNumber(...values) ?? undefined;
const optionalString = (...values: unknown[]) => firstString(...values) ?? undefined;

const clampPercentage = (value: number) => Math.min(100, Math.max(0, value));

const ratioPercentage = (value: number | undefined, max: number | undefined) => {
  if (value === undefined || max === undefined || max <= 0) return null;
  return clampPercentage((value / max) * 100);
};

const temperaturePercentage = (temperatureC: number | undefined) => {
  if (temperatureC === undefined) return null;
  return clampPercentage(((temperatureC - 20) / (90 - 20)) * 100);
};

const fixed = (value: number, digits = 0) => value.toFixed(digits).replace(/\.0$/, '');
const formatMemoryGiB = (value: number) => (value / 1024).toFixed(1);
const formatPercent = (value: number) => `${fixed(value)}%`;
const formatTemperature = (value: number) => `${fixed(value)}°C`;
const formatWattsValue = (value: number) => fixed(value, Math.abs(value) < 10 ? 1 : 0);

const formatPowerText = (powerDrawW: number | undefined, powerLimitW: number | undefined) => {
  if (powerDrawW !== undefined && powerLimitW !== undefined) {
    return `${formatWattsValue(powerDrawW)} / ${formatWattsValue(powerLimitW)} W`;
  }
  if (powerDrawW !== undefined) return `${formatWattsValue(powerDrawW)} W`;
  if (powerLimitW !== undefined) return `Limit ${formatWattsValue(powerLimitW)} W`;
  return null;
};

const compactGpuName = (name: unknown) => {
  const fullName = firstString(name) ?? 'GPU';
  const compact = fullName
    .replace(/^NVIDIA\s+Corporation\s+/i, '')
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^GeForce\s+/i, '')
    .replace(/^Graphics Device\s+/i, '')
    .trim();

  return compact || fullName;
};

const sanitizeId = (value: string) => value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');

const isOkStatus = (status: string | null | undefined) => (status ? OK_STATUSES.has(status.toLowerCase()) : false);
const isProblemStatus = (status: string | null | undefined) => (status ? PROBLEM_STATUSES.has(status.toLowerCase()) : false);

const normalizeEntryState = (state: HealthStatusState): HealthStatusState => {
  const normalized = state.toLowerCase();
  if (OK_STATUSES.has(normalized)) return 'healthy';
  if (PROBLEM_STATUSES.has(normalized)) return 'unavailable';
  return state;
};

const healthState = (entry: TelemetryEntry): HealthStatusState => {
  const data = asRecord(entry.data);
  const ok = booleanValue(data.ok);
  const status = stringValue(data.status)?.toLowerCase();

  if (entry.last_error) return 'unavailable';
  if (entry.stale) return 'stale';
  if (ok === true || isOkStatus(status)) return 'healthy';
  if (ok === false || isProblemStatus(status)) return 'unavailable';
  return status ?? 'unknown';
};

const serviceState = (service: ServiceTelemetryStatus | null | undefined) =>
  service ? normalizeEntryState(healthState(service.health)) : 'loading';

const gpuCardState = (service: ServiceTelemetryStatus, gpu?: Record<string, unknown>): HealthStatusState => {
  const health = normalizeEntryState(healthState(service.health));
  const gpuEntry = normalizeEntryState(healthState(service.gpu));
  const gpuStatus = stringValue(gpu?.status)?.toLowerCase();

  if (health === 'unavailable' || gpuEntry === 'unavailable' || isProblemStatus(gpuStatus)) return 'unavailable';
  if (health === 'stale' || gpuEntry === 'stale' || service.health.stale || service.gpu.stale) return 'stale';
  if (health === 'healthy' || gpuEntry === 'healthy' || isOkStatus(gpuStatus)) return 'healthy';
  return health !== 'unknown' ? health : gpuEntry;
};

const badgeClass = (state: HealthStatusState) => {
  const normalized = normalizeEntryState(state);
  if (normalized === 'healthy') return 'ok';
  if (normalized === 'stale') return 'stale';
  return 'warn';
};

const MetricBar = ({ label, displayText, percentage, variant = 'default' }: MetricBarProps) => (
  <div className={`gpu-metric ${variant === 'temperature' ? 'temperature' : ''}`}>
    <div className="gpu-metric-label">
      <span>{label}</span>
      <strong>{displayText}</strong>
    </div>
    <div className={`gpu-bar ${variant === 'temperature' ? 'temperature' : ''} ${percentage === null ? 'unknown' : ''}`} aria-hidden="true">
      <span style={{ width: `${percentage ?? 0}%` }} />
    </div>
  </div>
);

const StatusPill = ({ label, state }: { label: string; state: HealthStatusState }) => {
  const displayState = normalizeEntryState(state);

  return (
    <span className={`status-pill ${badgeClass(displayState)}`}>
      <span aria-hidden="true" />
      {label}: {displayState}
    </span>
  );
};

const StateBadge = ({ state }: { state: HealthStatusState }) => {
  const displayState = normalizeEntryState(state);

  return <span className={`badge ${badgeClass(displayState)}`}>{displayState}</span>;
};

const InfoTooltip = ({ label, rows }: { label: string; rows: DetailRow[] }) => {
  const tooltipId = useId();

  return (
    <span className="gpu-info">
      <button className="gpu-info-button" type="button" aria-label={label} aria-describedby={tooltipId}>
        i
      </button>
      <span className="gpu-info-tooltip" id={tooltipId} role="tooltip">
        {rows.map((row) => (
          <span className="gpu-info-row" key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </span>
        ))}
      </span>
    </span>
  );
};

const normalizeServiceGpuHealth = (
  machineId: string,
  machineLabel: string,
  service: ServiceTelemetryStatus
): NormalizedGpuHealth[] => {
  const data = asRecord(service.gpu.data);
  const records = gpuRecordsFromTelemetry(data);

  return records.map((record, position) => {
    const gpu = flattenTelemetryData(record);
    const index = optionalNumber(gpu.index, gpu.gpu_index, gpu.gpuIndex);
    const uuid = optionalString(gpu.uuid, gpu.gpu_uuid, gpu.gpuUuid);
    const name =
      optionalString(gpu.name, gpu.gpu_name, gpu.gpuName, gpu.product_name, gpu.productName) ??
      `GPU ${index ?? position}`;
    const shortName = compactGpuName(name);
    const identity = uuid ?? (index !== undefined ? `index-${index}` : `slot-${position}`);

    return {
      id: sanitizeId(`${machineId}-${identity}-${shortName}`),
      machineId,
      machineLabel,
      index,
      uuid,
      name,
      shortName,
      driverVersion: optionalString(gpu.driver_version, gpu.driverVersion, gpu.driver),
      memoryTotalMiB: optionalNumber(gpu.memory_total_mib, gpu.memoryTotalMiB, gpu.memoryTotalMib, gpu.memory_total_mb),
      memoryUsedMiB: optionalNumber(gpu.memory_used_mib, gpu.memoryUsedMiB, gpu.memoryUsedMib, gpu.memory_used_mb),
      memoryFreeMiB: optionalNumber(gpu.memory_free_mib, gpu.memoryFreeMiB, gpu.memoryFreeMib, gpu.memory_free_mb),
      utilizationGpuPercent: optionalNumber(
        gpu.utilization_gpu_percent,
        gpu.utilizationGpuPercent,
        gpu.gpu_utilization_percent,
        gpu.gpuUtilizationPercent,
        gpu.utilization_percent,
        gpu.utilizationPercent
      ),
      temperatureC: optionalNumber(gpu.temperature_gpu_c, gpu.temperature_c, gpu.temperatureC, gpu.temperature),
      powerDrawW: optionalNumber(gpu.power_draw_w, gpu.powerDrawW, gpu.power_draw, gpu.powerDraw),
      powerLimitW: optionalNumber(gpu.power_limit_w, gpu.powerLimitW, gpu.power_limit, gpu.powerLimit),
      fanSpeedPercent: optionalNumber(gpu.fan_speed_percent, gpu.fanSpeedPercent, gpu.fan_percent, gpu.fanPercent),
      checkedAt: optionalString(gpu.checked_at, gpu.checkedAt, data.checked_at, data.checkedAt, service.gpu.last_success_at, service.gpu.last_checked_at),
      sourceEndpoint: optionalString(gpu.source_endpoint, gpu.sourceEndpoint, data.source_endpoint, data.sourceEndpoint),
      status: gpuCardState(service, gpu),
      gpuStatus: stringValue(gpu.status)?.toLowerCase() ?? undefined,
      healthError: service.health.last_error,
      gpuError: service.gpu.last_error,
      telemetryStale: service.health.stale || service.gpu.stale
    };
  });
};

const detailRows = (gpu: NormalizedGpuHealth): DetailRow[] =>
  [
    { label: 'Full name', value: gpu.name },
    { label: 'Machine', value: gpu.machineLabel },
    gpu.index !== undefined ? { label: 'GPU index', value: String(gpu.index) } : null,
    gpu.uuid ? { label: 'UUID', value: gpu.uuid } : null,
    gpu.driverVersion ? { label: 'Driver', value: gpu.driverVersion } : null,
    gpu.memoryFreeMiB !== undefined ? { label: 'Free VRAM', value: `${formatMemoryGiB(gpu.memoryFreeMiB)} GiB` } : null,
    gpu.checkedAt ? { label: 'Checked', value: gpu.checkedAt } : null,
    gpu.sourceEndpoint ? { label: 'Source', value: gpu.sourceEndpoint } : null,
    gpu.healthError ? { label: 'Health error', value: gpu.healthError } : null,
    gpu.gpuError ? { label: 'GPU error', value: gpu.gpuError } : null
  ].filter((row): row is DetailRow => row !== null);

const serviceDetailRows = (machineLabel: string, service: ServiceTelemetryStatus): DetailRow[] => {
  const data = asRecord(service.gpu.data);

  return [
    { label: 'Machine', value: machineLabel },
    service.gpu.last_checked_at ? { label: 'Checked', value: service.gpu.last_checked_at } : null,
    optionalString(data.source_endpoint, data.sourceEndpoint) ? { label: 'Source', value: optionalString(data.source_endpoint, data.sourceEndpoint) ?? '' } : null,
    service.health.last_error ? { label: 'Health error', value: service.health.last_error } : null,
    service.gpu.last_error ? { label: 'GPU error', value: service.gpu.last_error } : null
  ].filter((row): row is DetailRow => row !== null && row.value.length > 0);
};

const StatusFootnote = ({ gpu }: { gpu: NormalizedGpuHealth }) => {
  const gpuStatusIsProblem = isProblemStatus(gpu.gpuStatus);

  if (!gpu.healthError && !gpu.gpuError && !gpu.telemetryStale && !gpuStatusIsProblem) return null;

  return (
    <div className="status-footnote">
      {gpu.healthError && <span>Health: {gpu.healthError}</span>}
      {gpu.gpuError && <span>GPU: {gpu.gpuError}</span>}
      {gpuStatusIsProblem && <span>GPU status: {gpu.gpuStatus}</span>}
      {gpu.telemetryStale && <span>Telemetry stale</span>}
    </div>
  );
};

const GpuStatusCard = ({ gpu }: { gpu: NormalizedGpuHealth }) => {
  const title = `${gpu.shortName}.${gpu.machineLabel}`;
  const hasVram = gpu.memoryUsedMiB !== undefined && gpu.memoryTotalMiB !== undefined && gpu.memoryTotalMiB > 0;
  const powerText = formatPowerText(gpu.powerDrawW, gpu.powerLimitW);
  const hasFan = gpu.fanSpeedPercent !== undefined;
  const hasUtilization = gpu.utilizationGpuPercent !== undefined;
  const hasTemperature = gpu.temperatureC !== undefined;
  const hasMetrics = hasVram || powerText !== null || hasFan || hasUtilization || hasTemperature;

  return (
    <article className="status-card" aria-label={`${title} status ${normalizeEntryState(gpu.status)}`}>
      <div className="status-card-header">
        <div className="status-card-title-wrap">
          <h3 className="gpu-card-title" title={title}>
            {title}
          </h3>
        </div>
        <div className="gpu-card-actions">
          <StateBadge state={gpu.status} />
          <InfoTooltip label={`GPU details for ${title}`} rows={detailRows(gpu)} />
        </div>
      </div>

      {hasVram && (
        <MetricBar
          label="VRAM"
          displayText={`${formatMemoryGiB(gpu.memoryUsedMiB!)} / ${formatMemoryGiB(gpu.memoryTotalMiB!)} GiB`}
          percentage={ratioPercentage(gpu.memoryUsedMiB, gpu.memoryTotalMiB)}
        />
      )}
      {powerText && (
        <MetricBar label="Power" displayText={powerText} percentage={ratioPercentage(gpu.powerDrawW, gpu.powerLimitW)} />
      )}
      {hasFan && <MetricBar label="Fan" displayText={formatPercent(gpu.fanSpeedPercent!)} percentage={clampPercentage(gpu.fanSpeedPercent!)} />}
      {hasUtilization && (
        <MetricBar
          label="Utilization"
          displayText={formatPercent(gpu.utilizationGpuPercent!)}
          percentage={clampPercentage(gpu.utilizationGpuPercent!)}
        />
      )}
      {hasTemperature && (
        <MetricBar
          label="Temperature"
          displayText={formatTemperature(gpu.temperatureC!)}
          percentage={temperaturePercentage(gpu.temperatureC)}
          variant="temperature"
        />
      )}

      {!hasMetrics && <p className="gpu-no-data">GPU metrics unavailable.</p>}
      <StatusFootnote gpu={gpu} />
    </article>
  );
};

const NoGpuStatusCard = ({ machineLabel, service }: { machineLabel: string; service: ServiceTelemetryStatus }) => {
  const state = gpuCardState(service);
  const title = `GPU.${machineLabel}`;
  const message = service.gpu.last_error ? 'GPU telemetry unavailable.' : 'No GPUs reported.';
  const rows = serviceDetailRows(machineLabel, service);

  return (
    <article className="status-card" aria-label={`${machineLabel} GPU status ${normalizeEntryState(state)}`}>
      <div className="status-card-header">
        <div className="status-card-title-wrap">
          <h3 className="gpu-card-title" title={title}>
            {title}
          </h3>
        </div>
        <div className="gpu-card-actions">
          <StateBadge state={state} />
          <InfoTooltip label={`GPU details for ${machineLabel}`} rows={rows} />
        </div>
      </div>
      <p className="gpu-no-data">{message}</p>
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

const renderServiceGpuCards = (machineId: string, machineLabel: string, service: ServiceTelemetryStatus) => {
  const gpus = normalizeServiceGpuHealth(machineId, machineLabel, service);

  if (gpus.length === 0) {
    return <NoGpuStatusCard machineLabel={machineLabel} service={service} key={`${machineId}-no-gpu`} />;
  }

  return gpus.map((gpu) => <GpuStatusCard gpu={gpu} key={gpu.id} />);
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
            {renderServiceGpuCards('local-ai-llm', 'local-ai-llm', status.llm)}
            {renderServiceGpuCards('local-ai-voice', 'local-ai-voice', status.voice)}
          </>
        )}
      </div>
    )}
  </section>
);
