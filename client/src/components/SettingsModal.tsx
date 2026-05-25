import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { api, ApiClientError } from '../lib/api.js';
import type { AuthUser, AvailableModelInfo, ModelManagementStatus, ModelRuntimeInfo } from '../lib/types.js';

interface SettingsModalProps {
  currentUser: AuthUser;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const errorMessage = (error: unknown) => {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
};

const formatBytes = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return null;
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
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
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

const availableModelDetails = (model: AvailableModelInfo) => {
  const items = [
    model.details?.parameterSize ? `${model.details.parameterSize}` : null,
    model.details?.quantization ? `${model.details.quantization}` : null,
    model.details?.family ? `${model.details.family}` : null,
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
    warnings.push('Could not load available Ollama models. Manual model-name entry is available.');
  }
  if (status.source.ollamaPs.status === 'error') {
    warnings.push('Could not load running models from Ollama /api/ps. Loaded model details may be partial.');
  }

  return warnings;
};

export const SettingsModal = ({ currentUser, returnFocusRef, onClose }: SettingsModalProps) => {
  const dialogRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<ModelManagementStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingModel, setLoadingModel] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canManageModels = currentUser.isAdmin && currentUser.displayName.trim().toLowerCase() === 'eric';
  const warnings = useMemo(() => sourceWarnings(status), [status]);
  const selectedModelToLoad = manualModel.trim() || selectedModel.trim();
  const allSourcesFailed =
    status !== null &&
    status.source.health.status === 'error' &&
    status.source.ollamaTags.status === 'error' &&
    status.source.ollamaPs.status === 'error';

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError(null);
    try {
      const response = await api.getModelSettings();
      setStatus(response);
      setSelectedModel((current) => current || response.defaultModel || response.availableModels[0]?.name || '');
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

  const submitModelLoad = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const model = selectedModelToLoad;
    if (!model || loadingModel || !canManageModels) return;

    setLoadingModel(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.loadModel(model, makeDefault);
      setStatus(response);
      setSelectedModel(model);
      setManualModel('');
      setNotice(response.message ?? (makeDefault ? 'Model loaded and set as default.' : 'Model loaded successfully.'));
    } catch (loadError) {
      setError(`Model load failed: ${errorMessage(loadError)}`);
    } finally {
      setLoadingModel(false);
    }
  };

  const refresh = async () => {
    setNotice(null);
    await loadStatus();
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
            <button className="settings-nav-item active" type="button" aria-current="page">
              Models
            </button>
          </nav>

          <div className="settings-content" aria-busy={loadingStatus || loadingModel}>
            <section className="settings-section" aria-labelledby="local-llm-model-title">
              <div className="settings-section-header">
                <div>
                  <p className="eyebrow">Model Management</p>
                  <h3 id="local-llm-model-title">Local LLM Model</h3>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void refresh()}
                  disabled={loadingStatus || loadingModel}
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

              <div className="settings-status-grid">
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
                  <small>The loaded state is inferred from local-ai-llm health and Ollama /api/ps.</small>
                </div>
              </div>

              <div className="model-panel-grid">
                <article className="model-panel">
                  <div className="model-panel-header">
                    <h4>Loaded models</h4>
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
                    <h4>Available local models</h4>
                    <span>{status?.availableModels.length ?? 0}</span>
                  </div>
                  {status && status.availableModels.length > 0 ? (
                    <div className="model-list available-model-list">
                      {status.availableModels.map((model) => {
                        const details = availableModelDetails(model);
                        return (
                          <div key={model.name} className="model-row">
                            <strong>{model.name}</strong>
                            {details.length > 0 && <small>{details.join(' · ')}</small>}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="muted padded">
                      No local Ollama models were reported. Enter a model name manually below.
                    </p>
                  )}
                </article>
              </div>

              <form className="model-load-form" onSubmit={submitModelLoad}>
                <div className="form-grid-two">
                  <div>
                    <label className="field-label" htmlFor="settings-model-select">
                      Select model
                    </label>
                    <select
                      id="settings-model-select"
                      value={selectedModel}
                      onChange={(event) => setSelectedModel(event.target.value)}
                      disabled={!canManageModels || loadingModel || (status?.availableModels.length ?? 0) === 0}
                    >
                      <option value="">Choose a local model</option>
                      {status?.availableModels.map((model) => (
                        <option key={model.name} value={model.name}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="field-label" htmlFor="settings-model-manual">
                      Manual model name fallback
                    </label>
                    <input
                      id="settings-model-manual"
                      value={manualModel}
                      onChange={(event) => setManualModel(event.target.value)}
                      placeholder="qwen3:14b"
                      maxLength={120}
                      disabled={!canManageModels || loadingModel}
                    />
                  </div>
                </div>

                <p className="auth-help">
                  Manual entry is available when discovery fails or when an installed Ollama model is not listed. It
                  overrides the dropdown for this load request.
                </p>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={makeDefault}
                    onChange={(event) => setMakeDefault(event.target.checked)}
                    disabled={!canManageModels || loadingModel}
                  />
                  <span>
                    <strong>Make this the default model</strong>
                    <small>The default model is used for new Bear Castle AI chat requests.</small>
                  </span>
                </label>

                {!canManageModels && (
                  <div className="settings-admin-note" role="status">
                    Only an administrator can change models.
                  </div>
                )}

                <div className="button-row settings-actions-row">
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={!canManageModels || loadingModel || loadingStatus || !selectedModelToLoad}
                  >
                    {loadingModel ? 'Loading Model...' : 'Load Model'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
};
