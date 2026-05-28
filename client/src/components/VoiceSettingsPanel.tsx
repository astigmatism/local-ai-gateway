import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api.js';
import type {
  VoiceModelCatalogResponse,
  VoiceModelDescriptor,
  VoiceOverviewResponse,
  VoiceReferenceDescriptor
} from '../lib/types.js';

interface VoiceSettingsPanelProps {
  canManageVoice: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringValue = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const booleanValue = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'ok', 'healthy', 'up', 'online', 'ready', 'available'].includes(normalized)) return true;
    if (['false', '0', 'error', 'failed', 'down', 'offline', 'unavailable'].includes(normalized)) return false;
  }
  return null;
};

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = stringValue(value);
    if (parsed) return parsed;
  }
  return null;
};

const errorMessage = (error: unknown) => {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
};

const statusText = (value: unknown) => {
  const record = asRecord(value);
  if (!record) return 'Unknown';
  const ok = booleanValue(record.ok ?? record.healthy ?? record.available);
  return firstString(record.status, record.state, record.ready, ok === true ? 'healthy' : ok === false ? 'unavailable' : undefined) ?? 'Unknown';
};

const workerStatusText = (overview: VoiceOverviewResponse | null, key: 'stt' | 'tts') => {
  const services = asRecord(overview?.services);
  const workers = asRecord(services?.workers);
  const serviceRecord =
    asRecord(services?.[key]) ??
    asRecord(services?.[`${key}Worker`]) ??
    asRecord(services?.[`${key}_worker`]) ??
    asRecord(workers?.[key]);
  return statusText(serviceRecord ?? overview?.models[key]?.worker ?? null);
};

const formatMiB = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return 'Unavailable';
  return `${(value / 1024).toFixed(1)} GiB`;
};

const formatBytes = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

const formatDuration = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return null;
  if (value < 60) return `${value.toFixed(1)} s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatDateTime = (value?: string) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
};

const modelOptionValue = (model: VoiceModelDescriptor) => model.model ?? model.name ?? model.id;

const modelDetails = (model: VoiceModelDescriptor) =>
  [model.provider, model.language, model.languages?.join('/'), model.description].filter((item): item is string => Boolean(item));

const suggestedModel = (catalog: VoiceModelCatalogResponse | null | undefined) =>
  catalog?.activeModel ?? catalog?.loadedModel ?? catalog?.defaultModel ?? catalog?.models[0]?.model ?? catalog?.models[0]?.id ?? '';

const isWavFile = (file: File) => {
  const type = file.type.toLowerCase();
  return file.name.toLowerCase().endsWith('.wav') || type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave';
};

const referenceDetails = (reference: VoiceReferenceDescriptor) => {
  const uploaded = formatDateTime(reference.createdAt);
  const modified = !uploaded ? formatDateTime(reference.modifiedAt) : null;
  return [
    reference.originalFilename && reference.originalFilename !== reference.displayName
      ? `original: ${reference.originalFilename}`
      : null,
    reference.storedFilename && reference.storedFilename !== reference.displayName
      ? `stored as: ${reference.storedFilename}`
      : null,
    reference.provider,
    reference.model,
    reference.language,
    reference.type,
    reference.description,
    formatBytes(reference.sizeBytes),
    formatDuration(reference.durationSeconds),
    uploaded ? `uploaded: ${uploaded}` : null,
    modified ? `modified: ${modified}` : null,
    reference.id !== reference.displayName && reference.id !== reference.storedFilename ? `id: ${reference.id}` : null
  ].filter((item): item is string => Boolean(item));
};

export const VoiceSettingsPanel = ({ canManageVoice }: VoiceSettingsPanelProps) => {
  const [overview, setOverview] = useState<VoiceOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sttProvider, setSttProvider] = useState('fast-whisper');
  const [sttModel, setSttModel] = useState('');
  const [sttComputeType, setSttComputeType] = useState('int8_float16');
  const [ttsProvider, setTtsProvider] = useState('chatterbox');
  const [ttsModel, setTtsModel] = useState('');
  const [ttsLanguage, setTtsLanguage] = useState('en');
  const [sttDefaultModel, setSttDefaultModel] = useState('');
  const [sttDefaultComputeType, setSttDefaultComputeType] = useState('int8_float16');
  const [ttsDefaultModel, setTtsDefaultModel] = useState('');
  const [ttsDefaultLanguage, setTtsDefaultLanguage] = useState('en');
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referenceDisplayName, setReferenceDisplayName] = useState('');
  const [referenceDeleteUnsupported, setReferenceDeleteUnsupported] = useState(false);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);

  const sttCatalog = overview?.models.stt ?? null;
  const ttsCatalog = overview?.models.tts ?? null;
  const references = overview?.references?.references ?? [];
  const selectedReference = overview?.references?.selectedReference ?? null;
  const activeReference = overview?.references?.activeReference ?? null;
  const activeReferenceKnown = overview?.references?.activeReferenceKnown ?? false;
  const loadedReferenceFromOverview = overview?.references?.loadedReference ?? selectedReference ?? (activeReferenceKnown ? activeReference : null);
  const loadedReferenceId = loadedReferenceFromOverview?.id ?? references.find((reference) => reference.isLoaded)?.id ?? null;
  const loadedReference = loadedReferenceFromOverview ?? references.find((reference) => reference.id === loadedReferenceId) ?? null;
  const loadedReferenceKnown = Boolean(overview?.references?.loadedReferenceKnown ?? loadedReference);
  const canSelectReferences = Boolean(overview?.references?.selection.canSelect);
  const canDeleteReferences = Boolean(overview?.references?.deletion?.canDelete) && !referenceDeleteUnsupported;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await api.getVoiceOverview());
    } catch (loadError) {
      setError(`Could not load voice settings: ${errorMessage(loadError)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const nextSttModel = suggestedModel(sttCatalog);
    const nextTtsModel = suggestedModel(ttsCatalog);
    if (!sttModel && nextSttModel) setSttModel(nextSttModel);
    if (!ttsModel && nextTtsModel) setTtsModel(nextTtsModel);
    if (sttCatalog?.provider && sttProvider === 'fast-whisper') setSttProvider(sttCatalog.provider);
    if (ttsCatalog?.provider && ttsProvider === 'chatterbox') setTtsProvider(ttsCatalog.provider);
    if (sttCatalog?.computeType && sttComputeType === 'int8_float16') setSttComputeType(sttCatalog.computeType);
    if (ttsCatalog?.language && ttsLanguage === 'en') setTtsLanguage(ttsCatalog.language);
  }, [sttCatalog, sttComputeType, sttModel, sttProvider, ttsCatalog, ttsLanguage, ttsModel, ttsProvider]);

  useEffect(() => {
    const sttDefault = overview?.config?.stt.defaultModel ?? sttCatalog?.defaultModel ?? '';
    const sttCompute = overview?.config?.stt.computeType ?? sttCatalog?.computeType ?? 'int8_float16';
    const ttsDefault = overview?.config?.tts.defaultModel ?? ttsCatalog?.defaultModel ?? '';
    const ttsLang = overview?.config?.tts.language ?? ttsCatalog?.language ?? 'en';
    setSttDefaultModel(sttDefault);
    setSttDefaultComputeType(sttCompute);
    setTtsDefaultModel(ttsDefault);
    setTtsDefaultLanguage(ttsLang);
  }, [overview?.config, sttCatalog?.computeType, sttCatalog?.defaultModel, ttsCatalog?.defaultModel, ttsCatalog?.language]);

  const runMutation = async (action: string, fn: () => Promise<{ message?: string }>) => {
    if (!canManageVoice || busyAction) return;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      const response = await fn();
      setNotice(response.message ?? 'Voice setting updated.');
      await refresh();
    } catch (mutationError) {
      if (mutationError instanceof ApiClientError && mutationError.code === 'REFERENCE_AUDIO_DELETE_UNSUPPORTED') {
        setReferenceDeleteUnsupported(true);
      }
      setError(`${action} failed: ${errorMessage(mutationError)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const submitSttLoad = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const model = sttModel.trim();
    const provider = sttProvider.trim() || 'fast-whisper';
    const computeType = sttComputeType.trim() || 'int8_float16';
    if (!model) return;
    void runMutation('STT load', () => api.loadSttModel({ provider, model, computeType, options: {} }));
  };

  const submitTtsLoad = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const model = ttsModel.trim();
    const provider = ttsProvider.trim() || 'chatterbox';
    const language = ttsLanguage.trim() || undefined;
    if (!model) return;
    void runMutation('TTS load', () => api.loadTtsModel({ provider, model, language, options: {} }));
  };

  const submitSttConfig = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const defaultModel = sttDefaultModel.trim() || undefined;
    const computeType = sttDefaultComputeType.trim() || undefined;
    if (!defaultModel && !computeType) return;
    void runMutation('STT config update', () => api.updateSttConfig({ defaultModel, computeType }));
  };

  const submitTtsConfig = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const defaultModel = ttsDefaultModel.trim() || undefined;
    const language = ttsDefaultLanguage.trim() || undefined;
    if (!defaultModel && !language) return;
    void runMutation('TTS config update', () => api.updateTtsConfig({ defaultModel, language }));
  };

  const handleReferenceFileChange = (file: File | null) => {
    setReferenceFile(file);
    setReferenceDisplayName(file?.name ?? '');
  };

  const submitReferenceAudio = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!referenceFile) return;
    if (!isWavFile(referenceFile)) {
      setError('Reference audio must be a WAV file. Browser WebM recordings are not uploaded as WAV.');
      return;
    }

    const displayName = referenceDisplayName.trim() || referenceFile.name;
    void runMutation('Reference audio upload', async () => {
      const response = await api.uploadReferenceAudio(referenceFile, {
        filename: referenceFile.name,
        displayName
      });
      setReferenceFile(null);
      setReferenceDisplayName('');
      if (referenceInputRef.current) referenceInputRef.current.value = '';
      return response;
    });
  };

  const isLoadedReference = (reference: VoiceReferenceDescriptor) =>
    loadedReferenceId ? reference.id === loadedReferenceId : Boolean(reference.isLoaded);

  const loadReferenceForTts = (reference: VoiceReferenceDescriptor) => {
    void runMutation(`Load reference ${reference.id}`, () => api.selectVoiceReference(reference.id));
  };

  const deleteReferenceAudio = (reference: VoiceReferenceDescriptor) => {
    if (isLoadedReference(reference)) {
      setError('Loaded reference cannot be deleted. Load another reference before deleting this one.');
      return;
    }

    const label = reference.displayName || reference.originalFilename || reference.storedFilename || reference.id;
    if (!window.confirm(`Delete reference audio "${label}" from VoiceVM? This cannot be undone.`)) {
      return;
    }
    void runMutation(`Delete reference ${reference.id}`, () => api.deleteVoiceReference(reference.id));
  };

  const gpuDevice = overview?.gpu?.devices[0];
  const health = statusText(overview?.health);
  const sttStatus = workerStatusText(overview, 'stt');
  const ttsStatus = workerStatusText(overview, 'tts');
  const voiceErrors = Object.entries(overview?.errors ?? {});

  const renderCatalog = (title: string, catalog: VoiceModelCatalogResponse | null) => (
    <article className="model-panel">
      <div className="model-panel-header">
        <h4>{title}</h4>
        <span>{catalog?.models.length ?? 0}</span>
      </div>
      {catalog && catalog.models.length > 0 ? (
        <div className="voice-model-list">
          {catalog.models.map((model) => {
            const details = modelDetails(model);
            return (
              <button
                key={`${title}-${model.id}`}
                className="voice-model-option"
                type="button"
                onClick={() => (catalog.kind === 'stt' ? setSttModel(modelOptionValue(model)) : setTtsModel(modelOptionValue(model)))}
              >
                <strong>{model.label}</strong>
                {details.length > 0 && <small>{details.join(' · ')}</small>}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="muted padded">No {title.toLowerCase()} were reported by the voice VM.</p>
      )}
    </article>
  );

  const renderReferenceCard = (reference: VoiceReferenceDescriptor) => {
    const details = referenceDetails(reference);
    const loadAction = `Load reference ${reference.id}`;
    const deleteAction = `Delete reference ${reference.id}`;
    const loaded = isLoadedReference(reference);
    const deleteDisabledReason = loaded
      ? 'Loaded reference cannot be deleted.'
      : reference.canDelete === false
        ? 'Delete is not available for this reference.'
        : undefined;
    const canDeleteReference = !deleteDisabledReason;
    const deleteHelpId = loaded ? `voice-reference-delete-help-${reference.id.replace(/[^A-Za-z0-9_-]/g, '-')}` : undefined;

    return (
      <div
        key={reference.id}
        className={`voice-descriptor-card voice-reference-card${loaded ? ' loaded' : ''}`}
        role="group"
        aria-label={`${reference.displayName}${loaded ? ', loaded reference' : ''}`}
      >
        <div className="voice-reference-main">
          <div className="voice-reference-title-row">
            <strong title={reference.id}>{reference.displayName}</strong>
          </div>
          {details.length > 0 && <small>{details.join(' · ')}</small>}
        </div>
        {canManageVoice && (
          <div className="voice-reference-actions">
            {canSelectReferences && !loaded && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => loadReferenceForTts(reference)}
                disabled={Boolean(busyAction)}
              >
                {busyAction === loadAction ? 'Loading...' : 'Load'}
              </button>
            )}
            {canDeleteReferences && (
              <>
                <button
                  className="danger-button subtle-danger"
                  type="button"
                  onClick={() => deleteReferenceAudio(reference)}
                  disabled={Boolean(busyAction) || !canDeleteReference}
                  title={deleteDisabledReason}
                  aria-describedby={deleteHelpId}
                >
                  {busyAction === deleteAction ? 'Deleting...' : 'Delete'}
                </button>
                {loaded && (
                  <small id={deleteHelpId} className="voice-reference-action-note">
                    Loaded reference cannot be deleted.
                  </small>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="settings-section" aria-labelledby="voice-settings-title" aria-busy={loading || Boolean(busyAction)}>
      <div className="settings-section-header">
        <div>
          <p className="eyebrow">Voice VM API Contract</p>
          <h3 id="voice-settings-title">Voice Service</h3>
        </div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading || Boolean(busyAction)}>
          Refresh
        </button>
      </div>

      {loading && !overview && <p className="muted padded">Loading voice service settings...</p>}

      {error && <div className="auth-error">{error}</div>}
      {notice && <div className="auth-success">{notice}</div>}

      {voiceErrors.map(([key, message]) => (
        <div className="settings-warning" key={key}>
          <strong>{key}</strong>: {message}
        </div>
      ))}

      <div className="settings-status-grid">
        <div className="settings-status-card">
          <span className="settings-status-label">Health</span>
          <strong>{health}</strong>
          <small>{overview?.health ? 'Reported by /api/health' : 'No health payload yet.'}</small>
        </div>
        <div className="settings-status-card">
          <span className="settings-status-label">Workers</span>
          <strong>STT {sttStatus} · TTS {ttsStatus}</strong>
          <small>/api/services and model worker status</small>
        </div>
        <div className="settings-status-card">
          <span className="settings-status-label">Voice GPU</span>
          <strong>{overview?.gpu?.available ? `${overview.gpu.devices.length || 1} device(s)` : 'Unavailable'}</strong>
          <small>
            {gpuDevice
              ? [
                  gpuDevice.name,
                  gpuDevice.memoryUsedMiB !== undefined && gpuDevice.memoryTotalMiB !== undefined
                    ? `${formatMiB(gpuDevice.memoryUsedMiB)} / ${formatMiB(gpuDevice.memoryTotalMiB)} VRAM`
                    : null,
                  gpuDevice.utilizationGpuPercent !== undefined ? `${gpuDevice.utilizationGpuPercent}% util` : null,
                  gpuDevice.temperatureC !== undefined ? `${gpuDevice.temperatureC}°C` : null
                ]
                  .filter(Boolean)
                  .join(' · ') || 'GPU device details are unavailable.'
              : 'No GPU device reported by /api/gpu.'}
          </small>
        </div>
      </div>

      <div className="model-panel-grid voice-settings-grid">
        {renderCatalog('STT Models', sttCatalog)}
        {renderCatalog('TTS Models', ttsCatalog)}
      </div>

      <div className="model-panel-grid voice-settings-grid">
        <article className="model-panel voice-control-panel">
          <div className="model-panel-header">
            <h4>Load STT model</h4>
            <span>/api/models/stt/load</span>
          </div>
          <form className="voice-settings-form" onSubmit={submitSttLoad}>
            <label className="field-label" htmlFor="voice-stt-provider">
              Provider
            </label>
            <input id="voice-stt-provider" value={sttProvider} onChange={(event) => setSttProvider(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <label className="field-label" htmlFor="voice-stt-model">
              Model
            </label>
            <input id="voice-stt-model" value={sttModel} onChange={(event) => setSttModel(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <label className="field-label" htmlFor="voice-stt-compute">
              Compute type
            </label>
            <input id="voice-stt-compute" value={sttComputeType} onChange={(event) => setSttComputeType(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <div className="inline-form-row voice-button-row">
              <button className="primary-button" type="submit" disabled={!canManageVoice || !sttModel.trim() || Boolean(busyAction)}>
                {busyAction === 'STT load' ? 'Loading...' : 'Load STT'}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void runMutation('STT unload', () => api.unloadSttModel({ strategy: 'soft', clearCache: true }))}
                disabled={!canManageVoice || Boolean(busyAction)}
              >
                {busyAction === 'STT unload' ? 'Unloading...' : 'Soft unload STT'}
              </button>
            </div>
          </form>
        </article>

        <article className="model-panel voice-control-panel">
          <div className="model-panel-header">
            <h4>Load TTS model</h4>
            <span>/api/models/tts/load</span>
          </div>
          <form className="voice-settings-form" onSubmit={submitTtsLoad}>
            <label className="field-label" htmlFor="voice-tts-provider">
              Provider
            </label>
            <input id="voice-tts-provider" value={ttsProvider} onChange={(event) => setTtsProvider(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <label className="field-label" htmlFor="voice-tts-model">
              Model
            </label>
            <input id="voice-tts-model" value={ttsModel} onChange={(event) => setTtsModel(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <label className="field-label" htmlFor="voice-tts-language">
              Language
            </label>
            <input id="voice-tts-language" value={ttsLanguage} onChange={(event) => setTtsLanguage(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <div className="inline-form-row voice-button-row">
              <button className="primary-button" type="submit" disabled={!canManageVoice || !ttsModel.trim() || Boolean(busyAction)}>
                {busyAction === 'TTS load' ? 'Loading...' : 'Load TTS'}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void runMutation('TTS unload', () => api.unloadTtsModel({ strategy: 'soft', clearCache: true }))}
                disabled={!canManageVoice || Boolean(busyAction)}
              >
                {busyAction === 'TTS unload' ? 'Unloading...' : 'Soft unload TTS'}
              </button>
            </div>
          </form>
        </article>
      </div>

      <div className="model-panel-grid voice-settings-grid">
        <article className="model-panel voice-control-panel">
          <div className="model-panel-header">
            <h4>STT defaults</h4>
            <span>/api/config/stt</span>
          </div>
          <form className="voice-settings-form" onSubmit={submitSttConfig}>
            <label className="field-label" htmlFor="voice-stt-default-model">
              Default model
            </label>
            <input id="voice-stt-default-model" value={sttDefaultModel} onChange={(event) => setSttDefaultModel(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <label className="field-label" htmlFor="voice-stt-default-compute">
              Compute type
            </label>
            <input id="voice-stt-default-compute" value={sttDefaultComputeType} onChange={(event) => setSttDefaultComputeType(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <button className="secondary-button" type="submit" disabled={!canManageVoice || Boolean(busyAction)}>
              Save STT defaults
            </button>
          </form>
        </article>

        <article className="model-panel voice-control-panel">
          <div className="model-panel-header">
            <h4>TTS defaults</h4>
            <span>/api/config/tts</span>
          </div>
          <form className="voice-settings-form" onSubmit={submitTtsConfig}>
            <label className="field-label" htmlFor="voice-tts-default-model">
              Default model
            </label>
            <input id="voice-tts-default-model" value={ttsDefaultModel} onChange={(event) => setTtsDefaultModel(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <label className="field-label" htmlFor="voice-tts-default-language">
              Language
            </label>
            <input id="voice-tts-default-language" value={ttsDefaultLanguage} onChange={(event) => setTtsDefaultLanguage(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            <button className="secondary-button" type="submit" disabled={!canManageVoice || Boolean(busyAction)}>
              Save TTS defaults
            </button>
          </form>
        </article>
      </div>

      <article className="model-panel voice-reference-panel">
        <div className="model-panel-header">
          <h4>Voices / reference audio</h4>
          <span>{references.length}</span>
        </div>

        <div className="voice-reference-current">
          <div>
            <span className="settings-status-label">Loaded reference</span>
            <strong>{loadedReferenceKnown && loadedReference ? loadedReference.displayName : 'None loaded'}</strong>
            <small>
              {loadedReferenceKnown && loadedReference
                ? 'Future TTS playback uses the highlighted loaded reference.'
                : 'Click Load on a reference to use it for future TTS playback.'}
            </small>
          </div>
        </div>

        {referenceDeleteUnsupported && (
          <div className="settings-warning">Delete is not supported by the current VoiceVM API. Reference delete controls are disabled.</div>
        )}

        {references.length > 0 ? (
          <div className="voice-descriptor-list">{references.map(renderReferenceCard)}</div>
        ) : (
          <p className="muted padded">No voice/reference descriptors were returned by /voices.</p>
        )}

        <form className="voice-reference-upload" onSubmit={submitReferenceAudio}>
          <label className="field-label" htmlFor="voice-reference-upload">
            Upload WAV reference clip
          </label>
          <div className="inline-form-row">
            <input
              ref={referenceInputRef}
              id="voice-reference-upload"
              type="file"
              accept="audio/wav,audio/x-wav,.wav"
              onChange={(event) => handleReferenceFileChange(event.currentTarget.files?.[0] ?? null)}
              disabled={!canManageVoice || Boolean(busyAction)}
            />
            <button className="primary-button" type="submit" disabled={!canManageVoice || !referenceFile || Boolean(busyAction)}>
              {busyAction === 'Reference audio upload' ? 'Uploading...' : 'Upload reference'}
            </button>
          </div>
          <label className="field-label" htmlFor="voice-reference-display-name">
            Display name
          </label>
          <input
            id="voice-reference-display-name"
            value={referenceDisplayName}
            maxLength={180}
            onChange={(event) => setReferenceDisplayName(event.target.value)}
            placeholder={referenceFile?.name ?? 'eric-reference.wav'}
            disabled={!canManageVoice || Boolean(busyAction)}
          />
          <small className="auth-help">
            Uploading adds the WAV clip to the list and keeps the currently loaded reference unchanged. Click Load next to a reference to use it for future TTS. Delete is disabled for the loaded reference and uses VoiceVM descriptor-provided delete links or Bear Castle's conservative reference-audio delete fallback when supported.
          </small>
        </form>
      </article>

      {!canManageVoice && <div className="settings-admin-note">Only Eric/admin can change voice models, defaults, or reference audio.</div>}

      <details className="advanced-details voice-advanced-details">
        <summary>Advanced voice details</summary>
        <pre>{JSON.stringify({ system: overview?.system, health: overview?.health, services: overview?.services }, null, 2)}</pre>
      </details>
    </section>
  );
};
