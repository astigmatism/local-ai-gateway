import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api.js';
import { useReferenceWavRecorder } from '../hooks/useReferenceWavRecorder.js';
import {
  formatReferenceRecordingDuration,
  referenceAudioRecordingScript,
  recommendedReferenceRecordingSeconds
} from '../lib/referenceAudioRecording.js';
import {
  defaultUserTtsPreference,
  mergeUserTtsPreference,
  normalizeUserTtsPreference,
  ttsProviderDisplayNames,
  ttsProviderOptions
} from '../lib/ttsPreferences.js';
import type {
  ChatterboxTtsPreference,
  KokoroTtsPreference,
  TtsProviderId,
  TtsProviderStatus,
  UserTtsPreference,
  UserTtsPreferencePatch,
  VoiceDescriptor,
  VoiceModelCatalogResponse,
  VoiceModelDescriptor,
  VoiceOverviewResponse,
  VoiceProviderModelCatalog,
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

const modelProviderDetail = (provider?: string) => {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === 'kokoro') return 'Kokoro';
  if (normalized === 'chatterbox') return 'Chatterbox TTS';
  return provider;
};

const modelLabelForProvider = (model: VoiceModelDescriptor, provider?: TtsProviderId) => {
  const normalizedProvider = provider ?? (model.provider?.trim().toLowerCase() as TtsProviderId | undefined);
  if (normalizedProvider === 'kokoro' && model.label.trim().toLowerCase() === 'kokoro') return 'Kokoro';
  return model.label;
};

const modelDetails = (model: VoiceModelDescriptor) =>
  [modelProviderDetail(model.provider), model.language, model.languages?.join('/'), model.description].filter((item): item is string => Boolean(item));

const suggestedModel = (catalog: VoiceModelCatalogResponse | null | undefined) =>
  catalog?.activeModel ?? catalog?.loadedModel ?? catalog?.defaultModel ?? catalog?.models[0]?.model ?? catalog?.models[0]?.id ?? '';

const providerCatalog = (
  catalog: VoiceModelCatalogResponse | null | undefined,
  provider: TtsProviderId
): VoiceProviderModelCatalog | null => {
  const scoped = catalog?.providers?.[provider];
  if (scoped) return scoped;
  const models = catalog?.models.filter((model) => model.provider === provider) ?? [];
  if (models.length === 0) return null;
  return {
    provider,
    currentModel: undefined,
    worker: null,
    models
  };
};

const suggestedProviderModel = (catalog: VoiceModelCatalogResponse | null | undefined, provider: TtsProviderId) => {
  const scoped = providerCatalog(catalog, provider);
  return (
    scoped?.currentModel ??
    scoped?.activeModel ??
    scoped?.loadedModel ??
    scoped?.defaultModel ??
    scoped?.models[0]?.model ??
    scoped?.models[0]?.id ??
    ''
  );
};

const providerLabel = (provider: TtsProviderId, status?: TtsProviderStatus | null) => {
  if (provider === 'kokoro') return 'Kokoro';
  if (status?.displayName && status.displayName.toLowerCase() !== 'chatterbox') return status.displayName;
  return ttsProviderDisplayNames[provider];
};

const capabilityText = (value: boolean | undefined) => (value === true ? 'yes' : value === false ? 'no' : 'unknown');

const providerFromVoiceDescriptor = (descriptor: VoiceDescriptor): TtsProviderId | null => {
  const values = [descriptor.provider, descriptor.id, descriptor.label, descriptor.model, descriptor.type]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  if (values.includes('kokoro')) return 'kokoro';
  if (values.includes('chatterbox')) return 'chatterbox';
  return null;
};

const isWavFile = (file: File) => {
  const type = file.type.toLowerCase();
  return file.name.toLowerCase().endsWith('.wav') || type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave';
};

const referenceRecordingUploadAction = 'Reference recording upload';

const defaultReferenceRecordingDisplayName = () => {
  const date = new Date();
  return `Recorded reference ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

const clampLevel = (level: number) => Math.min(1, Math.max(0.12, Number.isFinite(level) ? level : 0.12));


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
  const [ttsLifecycleProvider, setTtsLifecycleProvider] = useState<TtsProviderId>('chatterbox');
  const [ttsModel, setTtsModel] = useState('');
  const [ttsLanguage, setTtsLanguage] = useState('en');
  const [sttDefaultModel, setSttDefaultModel] = useState('');
  const [sttDefaultComputeType, setSttDefaultComputeType] = useState('int8_float16');
  const [ttsDefaultProvider, setTtsDefaultProvider] = useState<TtsProviderId>('chatterbox');
  const [ttsDefaultModel, setTtsDefaultModel] = useState('');
  const [ttsDefaultLanguage, setTtsDefaultLanguage] = useState('en');
  const [speechPreference, setSpeechPreference] = useState<UserTtsPreference>(() => normalizeUserTtsPreference(defaultUserTtsPreference));
  const [speechPreferenceDirty, setSpeechPreferenceDirty] = useState(false);
  const [testSpeechText, setTestSpeechText] = useState('Hello from Bear Castle AI.');
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referenceDisplayName, setReferenceDisplayName] = useState('');
  const [referenceRecorderOpen, setReferenceRecorderOpen] = useState(false);
  const [referenceRecordingDisplayName, setReferenceRecordingDisplayName] = useState('');
  const [referenceDeleteUnsupported, setReferenceDeleteUnsupported] = useState(false);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);

  const sttCatalog = overview?.models.stt ?? null;
  const ttsCatalog = overview?.models.tts ?? null;
  const ttsRegistry = overview?.ttsRegistry ?? null;
  const selectedSpeechProvider = speechPreference.provider;
  const chatterboxProviderStatus = ttsRegistry?.providers.chatterbox ?? null;
  const kokoroProviderStatus = ttsRegistry?.providers.kokoro ?? null;
  const selectedSpeechProviderStatus = selectedSpeechProvider === 'chatterbox' ? chatterboxProviderStatus : kokoroProviderStatus;
  const selectedSpeechProviderSupportsReference =
    selectedSpeechProvider === 'chatterbox' && (selectedSpeechProviderStatus?.capabilities.referenceAudio ?? true);
  const chatterboxSpeechPreference = speechPreference.chatterbox;
  const kokoroSpeechPreference = speechPreference.kokoro;
  const chatterboxProviderCatalog = providerCatalog(ttsCatalog, 'chatterbox');
  const kokoroProviderCatalog = providerCatalog(ttsCatalog, 'kokoro');
  const chatterboxModelOptions = chatterboxProviderCatalog?.models ?? [];
  const kokoroModelOptions = kokoroProviderCatalog?.models ?? [];
  const chatterboxDefaultModelLabel = chatterboxProviderCatalog?.currentModel ?? chatterboxProviderStatus?.model ?? 'provider default';
  const kokoroDefaultModelLabel = kokoroProviderCatalog?.currentModel ?? kokoroProviderStatus?.model ?? 'kokoro-default';
  const lifecycleProviderStatus = ttsRegistry?.providers[ttsLifecycleProvider] ?? null;
  const lifecycleProviderCatalog = providerCatalog(ttsCatalog, ttsLifecycleProvider);
  const lifecycleProviderModelOptions = lifecycleProviderCatalog?.models ?? [];
  const references = overview?.references?.references ?? [];
  const voiceDescriptors = overview?.voices?.voices ?? [];
  const selectedSpeechProviderVoices = voiceDescriptors.filter(
    (voice) => providerFromVoiceDescriptor(voice) === selectedSpeechProvider
  );
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
      const [overviewResult, preferenceResult] = await Promise.allSettled([
        api.getVoiceOverview(),
        api.getVoiceTtsPreference()
      ]);

      const loadErrors: string[] = [];
      if (overviewResult.status === 'fulfilled') {
        setOverview(overviewResult.value);
      } else {
        loadErrors.push(`voice service overview: ${errorMessage(overviewResult.reason)}`);
      }

      if (preferenceResult.status === 'fulfilled') {
        setSpeechPreference(normalizeUserTtsPreference(preferenceResult.value));
        setSpeechPreferenceDirty(false);
      } else {
        loadErrors.push(`my speech voice preference: ${errorMessage(preferenceResult.reason)}`);
      }

      if (loadErrors.length > 0) {
        setError(`Could not load ${loadErrors.join('; ')}.`);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const nextSttModel = suggestedModel(sttCatalog);
    const nextTtsModel = suggestedProviderModel(ttsCatalog, ttsLifecycleProvider) || suggestedModel(ttsCatalog);
    if (!sttModel && nextSttModel) setSttModel(nextSttModel);
    if (!ttsModel && nextTtsModel) setTtsModel(nextTtsModel);
    if (sttCatalog?.provider && sttProvider === 'fast-whisper') setSttProvider(sttCatalog.provider);
    if (sttCatalog?.computeType && sttComputeType === 'int8_float16') setSttComputeType(sttCatalog.computeType);
    const scopedLanguage = lifecycleProviderCatalog?.language ?? ttsCatalog?.language;
    if (scopedLanguage && ttsLanguage === 'en') setTtsLanguage(scopedLanguage);
  }, [lifecycleProviderCatalog?.language, sttCatalog, sttComputeType, sttModel, sttProvider, ttsCatalog, ttsLanguage, ttsLifecycleProvider, ttsModel]);

  useEffect(() => {
    const sttDefault = overview?.config?.stt.defaultModel ?? sttCatalog?.defaultModel ?? '';
    const sttCompute = overview?.config?.stt.computeType ?? sttCatalog?.computeType ?? 'int8_float16';
    const defaultProvider = overview?.config?.tts.defaultProvider ?? ttsRegistry?.defaultProvider ?? 'chatterbox';
    const defaultProviderCatalog = providerCatalog(ttsCatalog, defaultProvider);
    const ttsDefault = overview?.config?.tts.defaultModel ?? defaultProviderCatalog?.defaultModel ?? defaultProviderCatalog?.currentModel ?? '';
    const ttsLang = overview?.config?.tts.language ?? ttsCatalog?.language ?? 'en';
    setSttDefaultModel(sttDefault);
    setSttDefaultComputeType(sttCompute);
    setTtsDefaultProvider(defaultProvider);
    setTtsDefaultModel(ttsDefault);
    setTtsDefaultLanguage(ttsLang);
  }, [overview?.config, sttCatalog?.computeType, sttCatalog?.defaultModel, ttsCatalog, ttsRegistry]);

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

  const referenceRecorder = useReferenceWavRecorder({
    displayName: referenceRecordingDisplayName,
    onError: (message) => setError(`Reference recording failed: ${message}`),
    onRecordingComplete: async (recording) => {
      if (!selectedSpeechProviderSupportsReference) {
        setError('Reference audio is available only for Chatterbox TTS. Select Chatterbox TTS before uploading a reference WAV.');
        return;
      }
      const displayName = referenceRecordingDisplayName.trim() || recording.filename;
      await runMutation(referenceRecordingUploadAction, async () => {
        const response = await api.uploadReferenceAudio(recording.blob, {
          filename: recording.filename,
          displayName
        });
        setReferenceFile(null);
        setReferenceDisplayName('');
        setReferenceRecorderOpen(false);
        setReferenceRecordingDisplayName('');
        if (referenceInputRef.current) referenceInputRef.current.value = '';
        return {
          ...response,
          message: response.message ?? `Reference recording uploaded: ${displayName}.`
        };
      });
    }
  });

  const openReferenceRecorder = () => {
    if (!canManageVoice || busyAction || !selectedSpeechProviderSupportsReference) return;
    setError(null);
    setNotice(null);
    setReferenceRecordingDisplayName(referenceDisplayName.trim() || defaultReferenceRecordingDisplayName());
    setReferenceRecorderOpen(true);
  };

  const closeReferenceRecorder = () => {
    if (referenceRecorder.isEncoding || busyAction === referenceRecordingUploadAction) return;
    if (referenceRecorder.isRecording || referenceRecorder.isRequestingPermission) {
      referenceRecorder.cancelRecording();
    }
    setReferenceRecorderOpen(false);
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
    const language = ttsLanguage.trim() || undefined;
    if (!model) return;
    void runMutation('TTS load', () => api.loadTtsModel({ provider: ttsLifecycleProvider, model, language, options: {} }));
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
    if (!ttsDefaultProvider && !defaultModel && !language) return;
    void runMutation('TTS config update', () => api.updateTtsConfig({ defaultProvider: ttsDefaultProvider, defaultModel, language }));
  };

  const updateSpeechPreference = (patch: UserTtsPreferencePatch) => {
    setSpeechPreference((current) => mergeUserTtsPreference(current, patch));
    setSpeechPreferenceDirty(true);
  };

  const updateChatterboxSpeechPreference = (patch: Partial<ChatterboxTtsPreference>) => {
    updateSpeechPreference({ chatterbox: patch });
  };

  const updateKokoroSpeechPreference = (patch: Partial<KokoroTtsPreference>) => {
    updateSpeechPreference({ kokoro: patch });
  };

  const persistSpeechPreference = async (action = 'TTS preference save') => {
    if (busyAction) return null;
    setBusyAction(action);
    setError(null);
    setNotice(null);
    try {
      const saved = normalizeUserTtsPreference(
        await api.updateVoiceTtsPreference({
          provider: speechPreference.provider,
          chatterbox: speechPreference.chatterbox,
          kokoro: speechPreference.kokoro
        })
      );
      setSpeechPreference(saved);
      setSpeechPreferenceDirty(false);
      setNotice(`${ttsProviderDisplayNames[saved.provider]} is saved as your speech voice on the server.`);
      return saved;
    } catch (preferenceError) {
      setError(`${action} failed: ${errorMessage(preferenceError)}`);
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const saveSpeechProviderPreference = async () => {
    await persistSpeechPreference();
  };

  const testSpeech = async () => {
    const text = testSpeechText.trim();
    if (!text || busyAction) return;

    let preferenceForTest = speechPreference;
    if (speechPreferenceDirty) {
      const saved = await persistSpeechPreference('TTS preference save');
      if (!saved) return;
      preferenceForTest = saved;
    }

    setBusyAction('TTS test');
    setError(null);
    setNotice(null);
    try {
      const blob = await api.speakText(text);
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      audio.onended = () => URL.revokeObjectURL(objectUrl);
      audio.onerror = () => URL.revokeObjectURL(objectUrl);
      await audio.play();
      setNotice(`Generated test speech with ${ttsProviderDisplayNames[preferenceForTest.provider]} using your saved speech voice.`);
    } catch (testError) {
      setError(`TTS test failed: ${errorMessage(testError)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleReferenceFileChange = (file: File | null) => {
    setReferenceFile(file);
    setReferenceDisplayName(file?.name ?? '');
  };

  const submitReferenceAudio = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedSpeechProviderSupportsReference) {
      setError('Reference audio is available only for Chatterbox TTS. Select Chatterbox TTS before uploading a reference WAV.');
      return;
    }
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
  const readyTtsProviders = ttsProviderOptions.filter((provider) => {
    const status = ttsRegistry?.providers[provider];
    return status?.reachable && status.state === 'loaded';
  });
  const ttsStatus = readyTtsProviders.length > 0 ? `${readyTtsProviders.length} provider(s) loaded` : 'No loaded provider reported';
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
                <strong>{modelLabelForProvider(model)}</strong>
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

  const renderTtsProviderCard = (provider: TtsProviderId) => {
    const status = ttsRegistry?.providers[provider];
    const capabilities = status?.capabilities ?? {};
    const isReady = status?.reachable && status.state === 'loaded';
    return (
      <article className={`tts-provider-card${isReady ? ' loaded' : ''}${status?.reachable === false ? ' unreachable' : ''}`} key={provider}>
        <div className="tts-provider-card-header">
          <div>
            <h4>{providerLabel(provider, status)}</h4>
            <small>{status ? `Provider ID: ${provider}` : 'No provider status returned yet.'}</small>
          </div>
          <strong>{status?.reachable ? 'reachable' : 'unreachable'}</strong>
        </div>
        <dl className="tts-provider-facts">
          <div>
            <dt>State</dt>
            <dd>{status?.state ?? 'unknown'}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{status?.model ?? 'unknown'}</dd>
          </div>
          <div>
            <dt>Voice</dt>
            <dd>{status?.voice ?? 'unknown'}</dd>
          </div>
          {status?.workerPort && (
            <div>
              <dt>Worker</dt>
              <dd>port {status.workerPort}</dd>
            </div>
          )}
        </dl>
        <div className="tts-capability-list" aria-label={`${providerLabel(provider, status)} capabilities`}>
          <span>Reference audio: {capabilityText(capabilities.referenceAudio)}</span>
          <span>Voice selection: {capabilityText(capabilities.voiceSelection)}</span>
          <span>Language selection: {capabilityText(capabilities.languageSelection)}</span>
          <span>Speed control: {capabilityText(capabilities.speedControl)}</span>
        </div>
        {status?.lastError && <small className="settings-warning compact-warning">{status.lastError}</small>}
      </article>
    );
  };

  const renderTtsProviderCatalogs = () => (
    <article className="model-panel tts-provider-model-panel">
      <div className="model-panel-header">
        <h4>TTS Models by provider</h4>
        <span>{ttsCatalog?.models.length ?? 0}</span>
      </div>
      <div className="tts-provider-model-groups">
        {ttsProviderOptions.map((provider) => {
          const catalog = providerCatalog(ttsCatalog, provider);
          const models = catalog?.models ?? [];
          return (
            <div className="tts-provider-model-group" key={provider}>
              <div className="tts-provider-model-group-header">
                <strong>{providerLabel(provider, ttsRegistry?.providers[provider])}</strong>
                <small>{models.length} model(s)</small>
              </div>
              {models.length > 0 ? (
                <div className="voice-model-list">
                  {models.map((model) => {
                    const details = modelDetails(model);
                    return (
                      <button
                        key={`${provider}-${model.id}`}
                        className="voice-model-option"
                        type="button"
                        onClick={() => {
                          setTtsLifecycleProvider(provider);
                          setTtsModel(modelOptionValue(model));
                        }}
                      >
                        <strong>{modelLabelForProvider(model, provider)}</strong>
                        {details.length > 0 && <small>{details.join(' · ')}</small>}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="muted padded">No {providerLabel(provider, ttsRegistry?.providers[provider])} models were reported.</p>
              )}
            </div>
          );
        })}
      </div>
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
          <small>/api/services and provider-scoped TTS status</small>
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

      <article className="model-panel tts-provider-registry-panel">
        <div className="model-panel-header">
          <h4>TTS Providers</h4>
          <span>Default: {ttsProviderDisplayNames[ttsRegistry?.defaultProvider ?? 'chatterbox']}</span>
        </div>
        <div className="tts-provider-registry">
          {ttsProviderOptions.map((provider) => renderTtsProviderCard(provider))}
        </div>
        <p className="auth-help">
          Selecting a provider for Speak or lifecycle actions sends that provider ID with the request. It does not unload or replace the other provider.
        </p>
      </article>

      <div className="model-panel-grid voice-settings-grid">
        {renderCatalog('STT Models', sttCatalog)}
        {renderTtsProviderCatalogs()}
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
            <select
              id="voice-tts-provider"
              value={ttsLifecycleProvider}
              onChange={(event) => {
                const provider = event.target.value as TtsProviderId;
                setTtsLifecycleProvider(provider);
                setTtsModel(suggestedProviderModel(ttsCatalog, provider));
                setTtsLanguage(providerCatalog(ttsCatalog, provider)?.language ?? 'en');
              }}
              disabled={!canManageVoice || Boolean(busyAction)}
            >
              {ttsProviderOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider, ttsRegistry?.providers[provider])}
                </option>
              ))}
            </select>
            <small className="auth-help">
              Lifecycle actions target only {providerLabel(ttsLifecycleProvider, lifecycleProviderStatus)}. They do not unload the other provider.
            </small>
            <label className="field-label" htmlFor="voice-tts-model">
              {providerLabel(ttsLifecycleProvider, lifecycleProviderStatus)} model
            </label>
            {lifecycleProviderModelOptions.length > 0 ? (
              <select
                id="voice-tts-model"
                value={ttsModel}
                onChange={(event) => setTtsModel(event.target.value)}
                disabled={!canManageVoice || Boolean(busyAction)}
              >
                {lifecycleProviderModelOptions.map((model) => {
                  const value = modelOptionValue(model);
                  return (
                    <option key={`${ttsLifecycleProvider}-${model.id}`} value={value}>
                      {modelLabelForProvider(model, ttsLifecycleProvider)}
                    </option>
                  );
                })}
              </select>
            ) : (
              <input id="voice-tts-model" value={ttsModel} onChange={(event) => setTtsModel(event.target.value)} disabled={!canManageVoice || Boolean(busyAction)} />
            )}
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
                onClick={() =>
                  void runMutation('TTS reload', () =>
                    api.reloadTtsModel({ provider: ttsLifecycleProvider, model: ttsModel.trim() || undefined, language: ttsLanguage.trim() || undefined, options: {} })
                  )
                }
                disabled={!canManageVoice || Boolean(busyAction)}
              >
                {busyAction === 'TTS reload' ? 'Reloading...' : 'Reload TTS provider'}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  void runMutation('TTS unload', () =>
                    api.unloadTtsModel({ provider: ttsLifecycleProvider, strategy: 'soft', clearCache: true })
                  )
                }
                disabled={!canManageVoice || Boolean(busyAction)}
              >
                {busyAction === 'TTS unload' ? 'Unloading...' : 'Soft unload provider'}
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
            <label className="field-label" htmlFor="voice-tts-default-provider">
              Default provider
            </label>
            <select
              id="voice-tts-default-provider"
              value={ttsDefaultProvider}
              onChange={(event) => setTtsDefaultProvider(event.target.value as TtsProviderId)}
              disabled={!canManageVoice || Boolean(busyAction)}
            >
              {ttsProviderOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {ttsProviderDisplayNames[provider]}
                </option>
              ))}
            </select>
            <small className="auth-help">
                This fallback default is used only when a speech request omits a provider. It does not change your personal speech voice or unload providers.
              </small>
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

      <article className="model-panel voice-control-panel tts-speech-preference-panel">
        <div className="model-panel-header">
          <h4>My speech voice</h4>
          <span>{speechPreferenceDirty ? 'Unsaved changes' : 'Saved per user'}</span>
        </div>
        <div className="voice-settings-form">
          <p className="auth-help">
            Choose the TTS provider and voice used for your Speak buttons, generated speech, and test speech. This is saved to your
            authenticated account on the server.
          </p>

          <div className="tts-provider-choice-group" role="group" aria-label="My speech voice provider">
            {ttsProviderOptions.map((provider) => {
              const status = provider === 'chatterbox' ? chatterboxProviderStatus : kokoroProviderStatus;
              const active = speechPreference.provider === provider;
              return (
                <button
                  key={provider}
                  className={`tts-provider-choice${active ? ' selected' : ''}`}
                  type="button"
                  aria-pressed={active}
                  onClick={() => updateSpeechPreference({ provider })}
                  disabled={Boolean(busyAction)}
                >
                  <strong>{providerLabel(provider, status)}</strong>
                  <small>{status?.state ?? 'unknown'} · {status?.reachable ? 'reachable' : 'unreachable'}</small>
                </button>
              );
            })}
          </div>
          <small className="auth-help">
            Saving this preference does not change the appliance fallback default and does not unload Chatterbox TTS or Kokoro.
          </small>

          {speechPreference.provider === 'chatterbox' ? (
            <div className="provider-preference-fields" aria-label="Chatterbox TTS speech preference">
              <label className="field-label" htmlFor="voice-speech-chatterbox-model">
                Chatterbox model
              </label>
              {chatterboxModelOptions.length > 0 ? (
                <select
                  id="voice-speech-chatterbox-model"
                  value={chatterboxSpeechPreference.model ?? ''}
                  onChange={(event) => updateChatterboxSpeechPreference({ model: event.target.value || undefined })}
                  disabled={Boolean(busyAction)}
                >
                  <option value="">Provider default ({chatterboxDefaultModelLabel})</option>
                  {chatterboxModelOptions.map((model) => {
                    const value = modelOptionValue(model);
                    return (
                      <option key={`speech-chatterbox-${model.id}`} value={value}>
                        {modelLabelForProvider(model, 'chatterbox')}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  id="voice-speech-chatterbox-model"
                  value={chatterboxSpeechPreference.model ?? ''}
                  onChange={(event) => updateChatterboxSpeechPreference({ model: event.target.value.trim() || undefined })}
                  placeholder={chatterboxDefaultModelLabel}
                  disabled={Boolean(busyAction)}
                />
              )}

              <label className="field-label" htmlFor="voice-speech-chatterbox-voice">
                Chatterbox voice
              </label>
              <input
                id="voice-speech-chatterbox-voice"
                list="voice-speech-chatterbox-voice-options"
                value={chatterboxSpeechPreference.voice ?? ''}
                onChange={(event) => updateChatterboxSpeechPreference({ voice: event.target.value.trim() || undefined })}
                placeholder={chatterboxProviderStatus?.voice ?? 'default or reference audio'}
                disabled={Boolean(busyAction)}
              />
              {selectedSpeechProviderVoices.length > 0 && (
                <>
                  <datalist id="voice-speech-chatterbox-voice-options">
                    {selectedSpeechProviderVoices.map((voice) => (
                      <option key={`chatterbox-voice-${voice.id}`} value={voice.id} label={voice.label} />
                    ))}
                  </datalist>
                  <small className="auth-help">Voice suggestions are scoped to Chatterbox TTS descriptors.</small>
                </>
              )}

              <div className="inline-form-row voice-button-row">
                <label className="field-label inline-field" htmlFor="voice-speech-chatterbox-language">
                  Language
                  <input
                    id="voice-speech-chatterbox-language"
                    value={chatterboxSpeechPreference.language ?? ''}
                    onChange={(event) => updateChatterboxSpeechPreference({ language: event.target.value.trim() || undefined })}
                    placeholder="en"
                    disabled={Boolean(busyAction)}
                  />
                </label>
                <label className="field-label inline-field" htmlFor="voice-speech-chatterbox-speed">
                  Speed
                  <input
                    id="voice-speech-chatterbox-speed"
                    type="number"
                    min="0.25"
                    max="4"
                    step="0.05"
                    value={chatterboxSpeechPreference.speed ?? 1}
                    onChange={(event) => updateChatterboxSpeechPreference({ speed: event.target.value === '' ? undefined : Number(event.target.value) })}
                    disabled={Boolean(busyAction)}
                  />
                </label>
              </div>

              {selectedSpeechProviderSupportsReference && (
                <>
                  <label className="field-label" htmlFor="voice-speech-chatterbox-reference">
                    Chatterbox reference audio
                  </label>
                  <select
                    id="voice-speech-chatterbox-reference"
                    value={chatterboxSpeechPreference.referenceAudioId ?? ''}
                    onChange={(event) => updateChatterboxSpeechPreference({ referenceAudioId: event.target.value || null })}
                    disabled={Boolean(busyAction)}
                  >
                    <option value="">Use loaded/default Chatterbox reference</option>
                    {references.map((reference) => (
                      <option key={`speech-reference-${reference.id}`} value={reference.id}>
                        {reference.displayName}
                      </option>
                    ))}
                  </select>
                  <small className="auth-help">
                    Reference audio is saved only in your Chatterbox TTS preference. Kokoro never receives referenceAudioId or referenceAudioPath.
                  </small>
                </>
              )}

              <div className="inline-form-row voice-button-row">
                <label className="field-label inline-field" htmlFor="voice-speech-chatterbox-exaggeration">
                  Exaggeration
                  <input
                    id="voice-speech-chatterbox-exaggeration"
                    type="number"
                    min="0"
                    max="5"
                    step="0.05"
                    value={chatterboxSpeechPreference.exaggeration ?? ''}
                    onChange={(event) => updateChatterboxSpeechPreference({ exaggeration: event.target.value === '' ? undefined : Number(event.target.value) })}
                    disabled={Boolean(busyAction)}
                  />
                </label>
                <label className="field-label inline-field" htmlFor="voice-speech-chatterbox-cfg-weight">
                  CFG weight
                  <input
                    id="voice-speech-chatterbox-cfg-weight"
                    type="number"
                    min="0"
                    max="5"
                    step="0.05"
                    value={chatterboxSpeechPreference.cfgWeight ?? ''}
                    onChange={(event) => updateChatterboxSpeechPreference({ cfgWeight: event.target.value === '' ? undefined : Number(event.target.value) })}
                    disabled={Boolean(busyAction)}
                  />
                </label>
                <label className="field-label inline-field" htmlFor="voice-speech-chatterbox-temperature">
                  Temperature
                  <input
                    id="voice-speech-chatterbox-temperature"
                    type="number"
                    min="0"
                    max="5"
                    step="0.05"
                    value={chatterboxSpeechPreference.temperature ?? ''}
                    onChange={(event) => updateChatterboxSpeechPreference({ temperature: event.target.value === '' ? undefined : Number(event.target.value) })}
                    disabled={Boolean(busyAction)}
                  />
                </label>
              </div>
              <small className="auth-help">Chatterbox models and reference audio are scoped to Chatterbox TTS only.</small>
            </div>
          ) : (
            <div className="provider-preference-fields" aria-label="Kokoro speech preference">
              <label className="field-label" htmlFor="voice-speech-kokoro-model">
                Kokoro model
              </label>
              {kokoroModelOptions.length > 1 ? (
                <select
                  id="voice-speech-kokoro-model"
                  value={kokoroSpeechPreference.model ?? ''}
                  onChange={(event) => updateKokoroSpeechPreference({ model: event.target.value || undefined })}
                  disabled={Boolean(busyAction)}
                >
                  <option value="">Provider default ({kokoroDefaultModelLabel})</option>
                  {kokoroModelOptions.map((model) => {
                    const value = modelOptionValue(model);
                    return (
                      <option key={`speech-kokoro-${model.id}`} value={value}>
                        {modelLabelForProvider(model, 'kokoro')}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <div className="settings-readonly-value" id="voice-speech-kokoro-model">
                  {kokoroSpeechPreference.model ?? kokoroDefaultModelLabel}
                </div>
              )}

              <label className="field-label" htmlFor="voice-speech-kokoro-voice">
                Kokoro voice
              </label>
              <input
                id="voice-speech-kokoro-voice"
                list="voice-speech-kokoro-voice-options"
                value={kokoroSpeechPreference.voice ?? ''}
                onChange={(event) => updateKokoroSpeechPreference({ voice: event.target.value.trim() || undefined })}
                placeholder={kokoroProviderStatus?.voice ?? 'af_heart'}
                disabled={Boolean(busyAction)}
              />
              {selectedSpeechProviderVoices.length > 0 && (
                <>
                  <datalist id="voice-speech-kokoro-voice-options">
                    {selectedSpeechProviderVoices.map((voice) => (
                      <option key={`kokoro-voice-${voice.id}`} value={voice.id} label={voice.label} />
                    ))}
                  </datalist>
                  <small className="auth-help">Voice suggestions are scoped to Kokoro descriptors.</small>
                </>
              )}

              <div className="inline-form-row voice-button-row">
                <label className="field-label inline-field" htmlFor="voice-speech-kokoro-language">
                  Language
                  <input
                    id="voice-speech-kokoro-language"
                    value={kokoroSpeechPreference.language ?? ''}
                    onChange={(event) => updateKokoroSpeechPreference({ language: event.target.value.trim() || undefined })}
                    placeholder="a"
                    disabled={Boolean(busyAction)}
                  />
                </label>
                <label className="field-label inline-field" htmlFor="voice-speech-kokoro-speed">
                  Speed
                  <input
                    id="voice-speech-kokoro-speed"
                    type="number"
                    min="0.25"
                    max="4"
                    step="0.05"
                    value={kokoroSpeechPreference.speed ?? 1}
                    onChange={(event) => updateKokoroSpeechPreference({ speed: event.target.value === '' ? undefined : Number(event.target.value) })}
                    disabled={Boolean(busyAction)}
                  />
                </label>
              </div>
              <small className="auth-help">Kokoro uses provider-scoped voice, language, and speed controls. Chatterbox reference audio controls are hidden.</small>
            </div>
          )}

          <label className="field-label" htmlFor="voice-speech-test-text">
            Test speech text
          </label>
          <textarea
            id="voice-speech-test-text"
            rows={3}
            value={testSpeechText}
            maxLength={1000}
            onChange={(event) => setTestSpeechText(event.target.value)}
            disabled={Boolean(busyAction)}
          />

          <div className="inline-form-row voice-button-row">
            <button className="secondary-button" type="button" onClick={() => void saveSpeechProviderPreference()} disabled={!speechPreferenceDirty || Boolean(busyAction)}>
              {busyAction === 'TTS preference save' ? 'Saving...' : 'Save my speech voice'}
            </button>
            <button className="primary-button" type="button" onClick={() => void testSpeech()} disabled={!testSpeechText.trim() || Boolean(busyAction)}>
              {busyAction === 'TTS test' ? 'Generating...' : `Generate ${ttsProviderDisplayNames[speechPreference.provider]} test`}
            </button>
          </div>
        </div>
      </article>

      <article className={`model-panel voice-reference-panel${selectedSpeechProviderSupportsReference ? '' : ' disabled'}`}>
        <div className="model-panel-header">
          <h4>Chatterbox reference audio</h4>
          <span>{references.length}</span>
        </div>

        {!selectedSpeechProviderSupportsReference ? (
          <p className="muted padded">
            Reference WAV controls are available only when Chatterbox TTS is selected. Kokoro is selected now and will not receive reference audio fields.
          </p>
        ) : (
          <>

        <div className="voice-reference-current">
          <div>
            <span className="settings-status-label">Loaded reference</span>
            <strong>{loadedReferenceKnown && loadedReference ? loadedReference.displayName : 'None loaded'}</strong>
            <small>
              {loadedReferenceKnown && loadedReference
                ? 'Future Chatterbox TTS playback uses the highlighted loaded reference.'
                : 'Click Load on a reference to use it for future Chatterbox TTS playback.'}
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
            <button
              className="secondary-button"
              type="button"
              onClick={openReferenceRecorder}
              disabled={!canManageVoice || Boolean(busyAction)}
            >
              Record reference
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
            Uploading or recording adds a WAV clip to the list and keeps the currently loaded reference unchanged. Click Load next to a reference to use it for future Chatterbox TTS. Browser recordings are converted to a mono PCM WAV before upload. Delete is disabled for the loaded reference and uses VoiceVM descriptor-provided delete links or Bear Castle's conservative reference-audio delete fallback when supported.
          </small>
        </form>
          </>
        )}
      </article>


      {referenceRecorderOpen && (
        <div className="voice-reference-recording-backdrop" role="presentation">
          <div
            className="voice-reference-recording-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="voice-reference-recording-title"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header voice-reference-recording-header">
              <div>
                <p className="eyebrow">Reference audio recorder</p>
                <h3 id="voice-reference-recording-title">Record a Chatterbox reference sample</h3>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={closeReferenceRecorder}
                disabled={referenceRecorder.isEncoding || busyAction === referenceRecordingUploadAction}
              >
                Close
              </button>
            </div>

            <div className="voice-reference-recording-body">
              <label className="field-label" htmlFor="voice-reference-recording-display-name">
                Display name
              </label>
              <input
                id="voice-reference-recording-display-name"
                value={referenceRecordingDisplayName}
                maxLength={180}
                onChange={(event) => setReferenceRecordingDisplayName(event.target.value)}
                placeholder="Recorded reference"
                disabled={
                  !canManageVoice ||
                  referenceRecorder.isRecording ||
                  referenceRecorder.isRequestingPermission ||
                  referenceRecorder.isEncoding ||
                  busyAction === referenceRecordingUploadAction
                }
              />

              <div className="voice-reference-script" aria-label="Read this script while recording">
                <span className="settings-status-label">Read this script</span>
                <p>{referenceAudioRecordingScript}</p>
              </div>

              <p className="auth-help">
                Aim for at least {recommendedReferenceRecordingSeconds} seconds, one speaker, a steady natural pace, and a quiet room.
                The browser records from your microphone and prepares a mono 16-bit PCM WAV before sending it through Bear Castle.
              </p>

              <div className="voice-reference-recorder-status" aria-live="polite">
                <strong>
                  {referenceRecorder.isRecording
                    ? 'Recording...'
                    : referenceRecorder.isRequestingPermission
                      ? 'Requesting microphone permission...'
                      : referenceRecorder.isEncoding || busyAction === referenceRecordingUploadAction
                        ? 'Preparing and uploading WAV...'
                        : 'Ready to record'}
                </strong>
                <span>{formatReferenceRecordingDuration(referenceRecorder.elapsedSeconds)}</span>
              </div>

              <div className="voice-level-meter voice-reference-level-meter" aria-hidden="true">
                {referenceRecorder.audioLevels.map((level, index) => (
                  <span
                    key={index}
                    style={{ '--voice-level-scale': clampLevel(level).toFixed(3) } as CSSProperties}
                  />
                ))}
              </div>

              <div className="button-row voice-reference-recording-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void referenceRecorder.startRecording()}
                  disabled={
                    !canManageVoice ||
                    referenceRecorder.isRecording ||
                    referenceRecorder.isRequestingPermission ||
                    referenceRecorder.isEncoding ||
                    Boolean(busyAction)
                  }
                >
                  {referenceRecorder.isRequestingPermission ? 'Opening microphone...' : 'Start recording'}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void referenceRecorder.stopRecording()}
                  disabled={!referenceRecorder.isRecording || Boolean(busyAction)}
                >
                  Done
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={closeReferenceRecorder}
                  disabled={referenceRecorder.isEncoding || busyAction === referenceRecordingUploadAction}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {!canManageVoice && <div className="settings-admin-note">Only Eric/admin can change voice models, defaults, or reference audio.</div>}

      <details className="advanced-details voice-advanced-details">
        <summary>Advanced voice details</summary>
        <pre>{JSON.stringify({ system: overview?.system, health: overview?.health, services: overview?.services, ttsRegistry }, null, 2)}</pre>
      </details>
    </section>
  );
};
