import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { api, ApiClientError } from '../lib/api.js';
import { VoiceSettingsPanel } from './VoiceSettingsPanel.js';
import type {
  AuthUser,
  AvailableModelInfo,
  ModelDetailsResponse,
  ModelManagementStatus,
  ModelPullProgressEvent,
  ModelRuntimeInfo
} from '../lib/types.js';

interface SettingsModalProps {
  currentUser: AuthUser;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

type SettingsSection = 'models' | 'voice';
type ModelManagerTab = 'overview' | 'installed' | 'browse' | 'storage';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const MODEL_EXAMPLES = ['qwen3:14b', 'llama3.1:8b', 'gemma3:12b', 'deepseek-r1:32b'];

const errorMessage = (error: unknown) => {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
};

const formatBytes = (value?: number | null) => {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const precision = amount >= 10 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
};

const formatDateTime = (value?: string) => {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
};

const truncateDigest = (value?: string) => {
  if (!value) return 'Unavailable';
  if (value.length <= 24) return value;
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
};

const defaultLoadedLabel = (loaded: boolean | null | undefined) => {
  if (loaded === true) return 'Loaded';
  if (loaded === false) return 'Not loaded';
  return 'Unknown';
};

const runtimeModelDetails = (model: ModelRuntimeInfo) => {
  const items = [
    model.sizeVram !== undefined ? `VRAM ${formatBytes(model.sizeVram)}` : null,
    model.size !== undefined ? `Size ${formatBytes(model.size)}` : null,
    model.contextLength !== undefined ? `Context ${model.contextLength.toLocaleString()}` : null,
    model.expiresAt ? `Expires ${formatDateTime(model.expiresAt)}` : null
  ];
  return items.filter((item): item is string => Boolean(item));
};

const modelMetadataDetails = (model: AvailableModelInfo) => {
  const items = [
    model.details?.parameterSize ? `${model.details.parameterSize}` : null,
    model.details?.quantization ? `${model.details.quantization}` : null,
    model.details?.family ? `${model.details.family}` : null,
    model.details?.format ? `${model.details.format}` : null,
    model.size !== undefined ? formatBytes(model.size) : null,
    model.modifiedAt ? `Modified ${formatDateTime(model.modifiedAt)}` : null
  ];
  return items.filter((item): item is string => Boolean(item));
};

const sourceWarnings = (status: ModelManagementStatus | null) => {
  if (!status) return [];
  const warnings: string[] = [];

  if (status.source.health.status === 'error') {
    warnings.push('Could not reach local-ai-llm. Default model status may be using the gateway fallback.');
  }
  if (status.source.ollamaTags.status === 'error') {
    warnings.push('Could not load installed Ollama models from /api/tags. Manual model-name entry is still available.');
  }
  if (status.source.ollamaPs.status === 'error') {
    warnings.push('Could not load running models from Ollama /api/ps. Loaded model details may be partial.');
  }
  if (status.source.storage.status === 'error') {
    warnings.push('Disk free/total is unavailable from local-ai-llm. Installed model footprint is still calculated from Ollama model sizes.');
  }

  return warnings;
};

const isRunningModel = (modelName: string, status: ModelManagementStatus | null) =>
  Boolean(status?.loadedModels.some((loadedModel) => loadedModel.name === modelName));

const isDefaultModel = (modelName: string, status: ModelManagementStatus | null) => status?.defaultModel === modelName;

const progressPercent = (event: ModelPullProgressEvent | null) => {
  if (!event) return null;
  if (typeof event.percent === 'number' && Number.isFinite(event.percent)) {
    return Math.max(0, Math.min(100, event.percent));
  }
  if (
    typeof event.completedBytes === 'number' &&
    typeof event.totalBytes === 'number' &&
    event.totalBytes > 0 &&
    Number.isFinite(event.completedBytes)
  ) {
    return Math.max(0, Math.min(100, (event.completedBytes / event.totalBytes) * 100));
  }
  return null;
};

const detailRows = (details: ModelDetailsResponse) => {
  const summary = details.summary;
  return [
    ['Model', summary.name || details.model],
    ['Size', summary.size !== undefined ? formatBytes(summary.size) : undefined],
    ['Modified', summary.modifiedAt ? formatDateTime(summary.modifiedAt) : undefined],
    ['Digest', summary.digest ? truncateDigest(summary.digest) : undefined],
    ['Format', summary.format],
    ['Family', summary.family],
    ['Families', summary.families?.join(', ')],
    ['Parameters', summary.parameterSize],
    ['Quantization', summary.quantization],
    ['Context length', summary.contextLength?.toLocaleString()],
    ['Capabilities', summary.capabilities?.join(', ')]
  ].filter((row): row is [string, string] => Boolean(row[1]));
};

const deletePrompt = (model: AvailableModelInfo, status: ModelManagementStatus | null) => {
  const lines = [
    `Delete ${model.name}?`,
    model.size !== undefined
      ? `This removes the local model files from local-ai-llm and frees approximately ${formatBytes(model.size)}.`
      : 'This removes the local model files from local-ai-llm. The model size is unknown.'
  ];

  if (isDefaultModel(model.name, status)) {
    lines.push('This model is currently the default. Chat may fail until another default model is set.');
  }

  if (isRunningModel(model.name, status)) {
    lines.push('This model is currently reported as loaded/running and may be in use.');
  }

  return lines.join('\n\n');
};

export const SettingsModal = ({ currentUser, returnFocusRef, onClose }: SettingsModalProps) => {
  const dialogRef = useRef<HTMLElement | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>('models');
  const [activeTab, setActiveTab] = useState<ModelManagerTab>('overview');
  const [status, setStatus] = useState<ModelManagementStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingModelName, setLoadingModelName] = useState<string | null>(null);
  const [defaultingModelName, setDefaultingModelName] = useState<string | null>(null);
  const [pullModelName, setPullModelName] = useState('');
  const [pullingModelName, setPullingModelName] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<ModelPullProgressEvent | null>(null);
  const [deletingModelName, setDeletingModelName] = useState<string | null>(null);
  const [selectedDetailsModel, setSelectedDetailsModel] = useState<string | null>(null);
  const [detailsLoadingModel, setDetailsLoadingModel] = useState<string | null>(null);
  const [detailsByModel, setDetailsByModel] = useState<Record<string, ModelDetailsResponse>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canManageModels = currentUser.isAdmin && currentUser.displayName.trim().toLowerCase() === 'eric';
  const warnings = useMemo(() => sourceWarnings(status), [status]);
  const allSourcesFailed =
    status !== null &&
    status.source.health.status === 'error' &&
    status.source.ollamaTags.status === 'error' &&
    status.source.ollamaPs.status === 'error';

  const sortedStorageModels = useMemo(() => {
    return [...(status?.availableModels ?? [])].sort((left, right) => (right.size ?? 0) - (left.size ?? 0));
  }, [status?.availableModels]);

  const currentPullPercent = progressPercent(pullProgress);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError(null);
    try {
      const response = await api.getModelSettings();
      setStatus(response);
    } catch (loadError) {
      setError(`Could not load model settings: ${errorMessage(loadError)}`);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => dialogRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      returnFocusRef?.current?.focus();
    };
  }, [onClose, returnFocusRef]);

  const refresh = async () => {
    setNotice(null);
    await loadStatus();
  };

  const loadModel = async (model: string, makeDefault: boolean) => {
    if (!model || !canManageModels || loadingModelName || defaultingModelName) return;

    if (makeDefault) setDefaultingModelName(model);
    else setLoadingModelName(model);
    setError(null);
    setNotice(null);
    try {
      const response = await api.loadModel(model, makeDefault);
      setStatus(response);
      setNotice(response.message ?? (makeDefault ? `${model} loaded and set as default.` : `${model} loaded successfully.`));
    } catch (loadError) {
      setError(`${makeDefault ? 'Make default' : 'Model load'} failed: ${errorMessage(loadError)}`);
    } finally {
      setLoadingModelName(null);
      setDefaultingModelName(null);
    }
  };

  const openDetails = async (model: string) => {
    if (selectedDetailsModel === model) {
      setSelectedDetailsModel(null);
      return;
    }

    setSelectedDetailsModel(model);
    setError(null);
    setNotice(null);
    if (detailsByModel[model]) return;

    setDetailsLoadingModel(model);
    try {
      const response = await api.getModelDetails(model);
      setDetailsByModel((current) => ({ ...current, [model]: response }));
    } catch (detailsError) {
      setError(`Could not load details for ${model}: ${errorMessage(detailsError)}`);
    } finally {
      setDetailsLoadingModel(null);
    }
  };

  const submitPull = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const model = pullModelName.trim();
    if (!model || !canManageModels || pullingModelName) return;

    const alreadyInstalled = status?.availableModels.some((installedModel) => installedModel.name === model);
    const promptLines = [
      alreadyInstalled ? `${model} is already installed. Pulling may update it.` : `Download ${model} to local-ai-llm?`,
      'Model size is unknown before pull. Make sure local-ai-llm has enough disk space.'
    ];
    if (status?.storage.disk?.availableBytes !== undefined) {
      promptLines.push(`Reported free disk space: ${formatBytes(status.storage.disk.availableBytes)}.`);
    }

    if (!window.confirm(promptLines.join('\n\n'))) return;

    setPullingModelName(model);
    setPullProgress({ type: 'progress', model, status: 'Starting download...', generatedAt: new Date().toISOString() });
    setError(null);
    setNotice(null);
    try {
      const finalEvent = await api.pullModel(model, (event) => setPullProgress(event));
      setPullProgress(finalEvent);
      setNotice(`${model} download completed.`);
      setPullModelName('');
      await loadStatus();
    } catch (pullError) {
      setError(`Model download failed: ${errorMessage(pullError)}`);
    } finally {
      setPullingModelName(null);
    }
  };

  const deleteLocalModel = async (model: AvailableModelInfo) => {
    if (!canManageModels || deletingModelName || pullingModelName === model.name || loadingModelName === model.name) return;
    if (!window.confirm(deletePrompt(model, status))) return;

    setDeletingModelName(model.name);
    setError(null);
    setNotice(null);
    try {
      const response = await api.deleteModel(model.name);
      setStatus(response);
      setNotice(response.message ?? `${model.name} deleted.`);
      setSelectedDetailsModel((current) => (current === model.name ? null : current));
      setDetailsByModel((current) => {
        const next = { ...current };
        delete next[model.name];
        return next;
      });
    } catch (deleteError) {
      setError(`Delete failed: ${errorMessage(deleteError)}`);
    } finally {
      setDeletingModelName(null);
    }
  };

  const renderOverview = () => (
    <div className="model-tab-panel">
      <div className="settings-status-grid model-overview-grid">
        <div className="settings-status-card">
          <span className="settings-status-label">Default model</span>
          <strong>{status?.defaultModel ?? 'Unknown'}</strong>
          {status?.defaultModelSource === 'gateway-fallback' && (
            <small>Gateway fallback is shown because local-ai-llm did not report a default.</small>
          )}
        </div>
        <div className="settings-status-card">
          <span className="settings-status-label">Default loaded</span>
          <strong>{defaultLoadedLabel(status?.defaultModelLoaded)}</strong>
          <small>Inferred from local-ai-llm health and Ollama /api/ps.</small>
        </div>
        <div className="settings-status-card">
          <span className="settings-status-label">Running models</span>
          <strong>{status?.loadedModels.length ?? 0}</strong>
          <small>Models currently loaded by Ollama or reported by local-ai-llm.</small>
        </div>
        <div className="settings-status-card">
          <span className="settings-status-label">Installed footprint</span>
          <strong>{formatBytes(status?.storage.installedModelBytes)}</strong>
          <small>{status?.storage.installedModelCount ?? 0} installed model(s) from Ollama /api/tags.</small>
        </div>
      </div>

      <div className="model-panel-grid">
        <article className="model-panel">
          <div className="model-panel-header">
            <h4>Running / loaded models</h4>
            <span>{status?.loadedModels.length ?? 0}</span>
          </div>
          {status && status.loadedModels.length > 0 ? (
            <div className="model-list compact-model-list">
              {status.loadedModels.map((model) => {
                const details = runtimeModelDetails(model);
                return (
                  <div key={model.name} className="model-row">
                    <strong>{model.name}</strong>
                    {details.length > 0 && <small>{details.join(' · ')}</small>}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted padded">No models are currently reported as loaded.</p>
          )}
        </article>

        <article className="model-panel">
          <div className="model-panel-header">
            <h4>Storage summary</h4>
            <span>{status?.source.storage.status === 'ok' ? 'Disk data' : 'Model sizes'}</span>
          </div>
          <div className="storage-summary-card">
            <p>
              <strong>{formatBytes(status?.storage.installedModelBytes)}</strong>
              <span> installed Ollama model footprint</span>
            </p>
            {status?.storage.disk ? (
              <>
                <p>
                  <strong>{formatBytes(status.storage.disk.availableBytes)}</strong>
                  <span> available on local-ai-llm</span>
                </p>
                <small>
                  Used {formatBytes(status.storage.disk.usedBytes)} of {formatBytes(status.storage.disk.totalBytes)}
                  {status.storage.disk.usedPercent !== undefined ? ` (${status.storage.disk.usedPercent.toFixed(1)}%)` : ''}
                </small>
              </>
            ) : (
              <small>Disk free/total is unavailable; installed model sizes are still shown.</small>
            )}
          </div>
        </article>
      </div>
    </div>
  );

  const renderDetailsPanel = (modelName: string) => {
    const details = detailsByModel[modelName];
    if (detailsLoadingModel === modelName) {
      return <div className="model-details-panel">Loading details...</div>;
    }
    if (!details) {
      return <div className="model-details-panel muted">Details are not loaded yet.</div>;
    }

    const rows = detailRows(details);
    return (
      <div className="model-details-panel">
        <div className="detail-grid">
          {rows.map(([label, value]) => (
            <div key={label} className="detail-card">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>

        {details.summary.license && (
          <details className="advanced-details">
            <summary>License</summary>
            <pre>{details.summary.license}</pre>
          </details>
        )}
        {details.summary.template && (
          <details className="advanced-details">
            <summary>Template</summary>
            <pre>{details.summary.template}</pre>
          </details>
        )}
        {details.summary.system && (
          <details className="advanced-details">
            <summary>System prompt</summary>
            <pre>{details.summary.system}</pre>
          </details>
        )}
        {details.summary.modelfile && (
          <details className="advanced-details">
            <summary>Modelfile</summary>
            <pre>{details.summary.modelfile}</pre>
          </details>
        )}
        <details className="advanced-details">
          <summary>Advanced raw details</summary>
          <pre>{JSON.stringify(details.raw, null, 2)}</pre>
        </details>
      </div>
    );
  };

  const renderInstalled = () => (
    <div className="model-tab-panel">
      {status && status.availableModels.length > 0 ? (
        <div className="model-table" role="table" aria-label="Installed Ollama models">
          <div className="model-table-row model-table-header" role="row">
            <span role="columnheader">Model</span>
            <span role="columnheader">Size</span>
            <span role="columnheader">Parameters</span>
            <span role="columnheader">Quantization</span>
            <span role="columnheader">Modified</span>
            <span role="columnheader">State</span>
            <span role="columnheader">Actions</span>
          </div>
          {status.availableModels.map((model) => {
            const running = isRunningModel(model.name, status);
            const defaultModel = isDefaultModel(model.name, status);
            const busy =
              loadingModelName === model.name ||
              defaultingModelName === model.name ||
              deletingModelName === model.name ||
              pullingModelName === model.name;
            return (
              <div key={model.name} className="model-table-entry">
                <div className="model-table-row" role="row">
                  <span className="model-table-cell model-name-cell" role="cell">
                    <strong>{model.name}</strong>
                    <small>{model.digest ? `Digest ${truncateDigest(model.digest)}` : modelMetadataDetails(model).join(' · ')}</small>
                  </span>
                  <span className="model-table-cell" role="cell">
                    {formatBytes(model.size)}
                  </span>
                  <span className="model-table-cell" role="cell">
                    {model.details?.parameterSize ?? 'Unavailable'}
                  </span>
                  <span className="model-table-cell" role="cell">
                    {model.details?.quantization ?? 'Unavailable'}
                  </span>
                  <span className="model-table-cell" role="cell">
                    {formatDateTime(model.modifiedAt)}
                  </span>
                  <span className="model-table-cell model-pill-group" role="cell">
                    {running && <span className="model-pill loaded">Running</span>}
                    {defaultModel && <span className="model-pill default">Default</span>}
                    {!running && !defaultModel && <span className="model-pill neutral">Installed</span>}
                  </span>
                  <span className="model-table-cell model-row-actions" role="cell">
                    <button className="secondary-button" type="button" onClick={() => void openDetails(model.name)}>
                      {selectedDetailsModel === model.name ? 'Hide details' : 'Details'}
                    </button>
                    {canManageModels && (
                      <>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => void loadModel(model.name, false)}
                          disabled={busy || Boolean(loadingModelName) || Boolean(defaultingModelName)}
                        >
                          {loadingModelName === model.name ? 'Loading...' : 'Load'}
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => void loadModel(model.name, true)}
                          disabled={busy || Boolean(loadingModelName) || Boolean(defaultingModelName)}
                        >
                          {defaultingModelName === model.name ? 'Setting...' : 'Make Default'}
                        </button>
                        <button
                          className="danger-button subtle-danger"
                          type="button"
                          onClick={() => void deleteLocalModel(model)}
                          disabled={busy || Boolean(deletingModelName) || pullingModelName === model.name}
                        >
                          {deletingModelName === model.name ? 'Deleting...' : 'Delete'}
                        </button>
                      </>
                    )}
                  </span>
                </div>
                {selectedDetailsModel === model.name && renderDetailsPanel(model.name)}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted padded">No local Ollama models were reported. Use Browse / Download to pull one by name.</p>
      )}

      {!canManageModels && <div className="settings-admin-note">Only an administrator can load, set defaults, or delete models.</div>}
    </div>
  );

  const renderBrowse = () => (
    <div className="model-tab-panel">
      <article className="model-panel browse-panel">
        <div className="model-panel-header">
          <h4>Download by model name</h4>
          <span>Manual</span>
        </div>
        <p className="auth-help">
          Enter a model name from the Ollama library, such as llama3.1:8b or qwen3:14b. Bear Castle AI pulls it through
          the gateway so the browser never talks directly to Ollama.
        </p>
        <p className="auth-help">
          Public catalog browsing is not enabled because this build does not depend on an official stable model-library
          search API. You can open the Ollama library in a new tab to copy an exact model name.
        </p>
        <a className="external-library-link" href={status?.catalog.libraryUrl ?? 'https://ollama.com/search'} target="_blank" rel="noreferrer">
          Open Ollama model library
        </a>

        <form className="model-download-form" onSubmit={submitPull}>
          <label className="field-label" htmlFor="model-download-name">
            Model name
          </label>
          <div className="inline-form-row">
            <input
              id="model-download-name"
              value={pullModelName}
              onChange={(event) => setPullModelName(event.target.value)}
              placeholder="llama3.1:8b"
              maxLength={120}
              disabled={!canManageModels || Boolean(pullingModelName)}
            />
            <button className="primary-button" type="submit" disabled={!canManageModels || !pullModelName.trim() || Boolean(pullingModelName)}>
              {pullingModelName ? 'Downloading...' : 'Pull Model'}
            </button>
          </div>
        </form>

        <div className="model-examples" aria-label="Example model names">
          {MODEL_EXAMPLES.map((example) => (
            <button
              key={example}
              className="model-example-button"
              type="button"
              onClick={() => setPullModelName(example)}
              disabled={!canManageModels || Boolean(pullingModelName)}
            >
              {example}
            </button>
          ))}
        </div>

        {pullProgress && (
          <div className="model-progress" role="status">
            <div className="model-progress-header">
              <strong>{pullProgress.model}</strong>
              <span>{pullProgress.status}</span>
            </div>
            <div className="model-progress-track" aria-label="Download progress">
              <span style={{ width: `${currentPullPercent ?? (pullingModelName ? 20 : 100)}%` }} />
            </div>
            <div className="model-progress-meta">
              {currentPullPercent !== null && <span>{currentPullPercent.toFixed(1)}%</span>}
              {pullProgress.completedBytes !== undefined && pullProgress.totalBytes !== undefined && (
                <span>
                  {formatBytes(pullProgress.completedBytes)} / {formatBytes(pullProgress.totalBytes)}
                </span>
              )}
            </div>
          </div>
        )}

        {!canManageModels && <div className="settings-admin-note">Only an administrator can download models.</div>}
      </article>
    </div>
  );

  const renderStorage = () => {
    const usedPercent = status?.storage.disk?.usedPercent;
    return (
      <div className="model-tab-panel">
        <div className="settings-status-grid model-overview-grid">
          <div className="settings-status-card">
            <span className="settings-status-label">Installed models</span>
            <strong>{formatBytes(status?.storage.installedModelBytes)}</strong>
            <small>{status?.storage.installedModelCount ?? 0} model(s) counted from Ollama /api/tags.</small>
          </div>
          <div className="settings-status-card">
            <span className="settings-status-label">Disk available</span>
            <strong>{formatBytes(status?.storage.disk?.availableBytes)}</strong>
            <small>
              {status?.storage.disk
                ? 'Disk data from local-ai-llm monitor storage endpoint.'
                : 'Disk data unavailable; showing installed model sizes only.'}
            </small>
          </div>
          <div className="settings-status-card">
            <span className="settings-status-label">Disk used</span>
            <strong>{usedPercent !== undefined ? `${usedPercent.toFixed(1)}%` : 'Unavailable'}</strong>
            <small>
              {status?.storage.disk
                ? `${formatBytes(status.storage.disk.usedBytes)} used of ${formatBytes(status.storage.disk.totalBytes)}`
                : 'Expose /storage or /disk on local-ai-llm to show capacity.'}
            </small>
          </div>
        </div>

        {status?.storage.disk && usedPercent !== undefined && (
          <div className="storage-progress" aria-label="local-ai-llm disk usage">
            <span style={{ width: `${Math.max(0, Math.min(100, usedPercent))}%` }} />
          </div>
        )}

        {status?.storage.warning && <div className="settings-warning">{status.storage.warning}</div>}

        <article className="model-panel">
          <div className="model-panel-header">
            <h4>Largest installed models</h4>
            <span>{sortedStorageModels.length}</span>
          </div>
          {sortedStorageModels.length > 0 ? (
            <div className="storage-model-list">
              {sortedStorageModels.map((model) => {
                const busy = deletingModelName === model.name || pullingModelName === model.name;
                return (
                  <div key={model.name} className="storage-model-row">
                    <div>
                      <strong>{model.name}</strong>
                      <small>{model.details?.parameterSize ?? 'Unknown parameters'} · {model.details?.quantization ?? 'Unknown quantization'}</small>
                    </div>
                    <span>{formatBytes(model.size)}</span>
                    {canManageModels && (
                      <button
                        className="danger-button subtle-danger"
                        type="button"
                        onClick={() => void deleteLocalModel(model)}
                        disabled={busy || Boolean(deletingModelName)}
                      >
                        {deletingModelName === model.name ? 'Deleting...' : 'Delete'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted padded">No installed model sizes are available.</p>
          )}
        </article>
      </div>
    );
  };

  return (
    <div
      className="modal-backdrop settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <div className="modal-header settings-header">
          <div>
            <p className="eyebrow">Bear Castle AI</p>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button className="secondary-button" type="button" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <button
              className={`settings-nav-item ${activeSection === 'models' ? 'active' : ''}`}
              type="button"
              aria-current={activeSection === 'models' ? 'page' : undefined}
              onClick={() => setActiveSection('models')}
            >
              Models
            </button>
            <button
              className={`settings-nav-item ${activeSection === 'voice' ? 'active' : ''}`}
              type="button"
              aria-current={activeSection === 'voice' ? 'page' : undefined}
              onClick={() => setActiveSection('voice')}
            >
              Voice
            </button>
          </nav>

          <div
            className="settings-content"
            aria-busy={activeSection === 'models' && Boolean(loadingStatus || loadingModelName || defaultingModelName || pullingModelName || deletingModelName)}
          >
            {activeSection === 'voice' ? (
              <VoiceSettingsPanel canManageVoice={canManageModels} />
            ) : (
            <section className="settings-section" aria-labelledby="model-manager-title">
              <div className="settings-section-header">
                <div>
                  <p className="eyebrow">Model Management</p>
                  <h3 id="model-manager-title">Ollama Model Manager</h3>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void refresh()}
                  disabled={loadingStatus || Boolean(pullingModelName)}
                >
                  Refresh
                </button>
              </div>

              {loadingStatus && !status && <p className="muted padded">Loading model status...</p>}

              {error && (
                <div className="auth-error" role="alert">
                  {error}
                </div>
              )}
              {notice && (
                <div className="auth-success" role="status">
                  {notice}
                </div>
              )}

              {allSourcesFailed && (
                <div className="settings-warning" role="status">
                  Model services are unavailable right now. Check local-ai-llm and Ollama, then refresh.
                </div>
              )}

              {warnings.map((warning) => (
                <div key={warning} className="settings-warning" role="status">
                  {warning}
                </div>
              ))}

              <div className="model-manager-tabs" role="tablist" aria-label="Model manager sections">
                {(['overview', 'installed', 'browse', 'storage'] as const).map((tab) => (
                  <button
                    key={tab}
                    className={`model-manager-tab ${activeTab === tab ? 'active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === 'overview' && 'Overview'}
                    {tab === 'installed' && 'Installed'}
                    {tab === 'browse' && 'Browse / Download'}
                    {tab === 'storage' && 'Storage'}
                  </button>
                ))}
              </div>

              {activeTab === 'overview' && renderOverview()}
              {activeTab === 'installed' && renderInstalled()}
              {activeTab === 'browse' && renderBrowse()}
              {activeTab === 'storage' && renderStorage()}
            </section>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
