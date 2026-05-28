import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../errors/apiError.js';
import { logger } from '../config/logger.js';
import {
  deleteReferenceAudio,
  listVoiceDescriptors,
  uploadReferenceAudio,
  type VoiceDescriptor,
  type VoiceDescriptorsResponse
} from './voiceClient.js';

type UnknownRecord = Record<string, unknown>;

type VoiceReferenceSource = 'voice-vm' | 'bear-castle';

type ReferenceSelectionMode = 'bear-castle-tts-voice';
type ReferenceDeletionMode = 'voice-vm-reference-audio-delete';

export interface StoredReferenceMetadata {
  id: string;
  originalFilename?: string;
  displayName?: string;
  storedFilename?: string;
  uploadedAt?: string;
  lastSeenAt?: string;
}

export interface VoiceReferenceState {
  version: 1;
  selectedReferenceId?: string;
  references: Record<string, StoredReferenceMetadata>;
  updatedAt?: string;
}

export interface VoiceReferenceDescriptor {
  id: string;
  displayName: string;
  originalFilename?: string;
  storedFilename?: string;
  path?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  createdAt?: string;
  modifiedAt?: string;
  provider?: string;
  model?: string;
  language?: string;
  description?: string;
  type?: string;
  isActive?: boolean;
  isSelected?: boolean;
  isLoaded?: boolean;
  canDelete: boolean;
  source: VoiceReferenceSource;
  raw?: unknown;
}

export interface VoiceReferenceSelectionCapability {
  mode: ReferenceSelectionMode;
  canSelect: true;
  activeReferenceExposedByVoiceVm: boolean;
  activeReferenceKnown: boolean;
  loadedReferenceKnown: boolean;
  loadedReferenceId?: string;
  loadedReferenceDisplayName?: string;
  selectedReferenceId?: string;
  selectedReferenceDisplayName?: string;
  selectedReferencePersistsIn: 'bear-castle';
  ttsSpeakField: 'voice';
}

export interface VoiceReferenceDeletionCapability {
  mode: ReferenceDeletionMode;
  canDelete: true;
  supportedBySuppliedVoiceVmContract: false;
  blocksLoadedReferenceDelete: true;
  clearsBearCastleSelection: false;
  clearsBearCastleMetadata: true;
}

export interface VoiceReferencesResponse {
  references: VoiceReferenceDescriptor[];
  loadedReference: VoiceReferenceDescriptor | null;
  loadedReferenceKnown: boolean;
  activeReference: VoiceReferenceDescriptor | null;
  selectedReference: VoiceReferenceDescriptor | null;
  activeReferenceKnown: boolean;
  selection: VoiceReferenceSelectionCapability;
  deletion: VoiceReferenceDeletionCapability;
  raw: unknown;
}

export interface UploadReferenceAudioOptions {
  displayName?: string;
}

const defaultState = (): VoiceReferenceState => ({
  version: 1,
  references: {}
});

let stateFilePath = path.resolve(process.cwd(), 'storage', 'voice-reference-state.json');
let cachedState: VoiceReferenceState | null = null;

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : null;

const stripControlCharacters = (value: string) =>
  Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint > 0x1f || codePoint === 0x09) && codePoint !== 0x7f;
    })
    .join('');

const hasControlCharacters = (value: string) => value !== stripControlCharacters(value);

const cleanString = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = stripControlCharacters(value).trim();
  return trimmed || undefined;
};

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = cleanString(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const cleanNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const cleanBoolean = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'active', 'selected', 'current', 'default'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'inactive'].includes(normalized)) return false;
  }
  return undefined;
};

const firstNumber = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = cleanNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const firstBoolean = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = cleanBoolean(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const readPath = (root: unknown, pathSegments: string[]) => {
  let current: unknown = root;
  for (const segment of pathSegments) {
    const record = asRecord(current);
    if (!record || !(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
};

const normalizePathSeparators = (value: string) => value.replace(/\\/g, '/');

export const sanitizeOriginalFilename = (value: unknown, fallback = 'reference.wav') => {
  const cleaned = cleanString(value);
  const filename = path.posix.basename(normalizePathSeparators(cleaned ?? fallback));
  const withoutControls = stripControlCharacters(filename).trim();
  return (withoutControls || fallback).slice(0, 180);
};

export const sanitizeDisplayName = (value: unknown, fallback?: string) => {
  const base = cleanString(value) ?? cleanString(fallback) ?? 'Reference audio';
  const filename = normalizePathSeparators(base).split('/').filter(Boolean).pop() ?? '';
  const displayName = stripControlCharacters(filename).trim();
  return (displayName || 'Reference audio').slice(0, 180);
};

const safeBasename = (value: unknown) => {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const basename = path.posix.basename(normalizePathSeparators(cleaned));
  return basename && basename !== '.' ? basename.slice(0, 180) : undefined;
};

const isProbablyFilename = (value: string | undefined) => Boolean(value && /\.[A-Za-z0-9]{1,8}$/.test(value));

const uniqueStrings = (values: Array<string | undefined>) => Array.from(new Set(values.filter((value): value is string => Boolean(value))));

const collectStrings = (value: unknown, output: string[], depth = 0) => {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const cleaned = cleanString(value);
    if (cleaned) output.push(cleaned);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, nestedValue] of Object.entries(record)) {
    const keyLooksRelevant = /id|voice|reference|file|path|name/i.test(key);
    if (keyLooksRelevant) collectStrings(nestedValue, output, depth + 1);
  }
};

const descriptorRecord = (descriptor: VoiceDescriptor) => asRecord(descriptor.raw) ?? {};

const storedFilenameFromDescriptor = (descriptor: VoiceDescriptor) => {
  const record = descriptorRecord(descriptor);
  const pathValue = firstString(
    record.path,
    record.filePath,
    record.file_path,
    record.referencePath,
    record.reference_path,
    record.referenceAudioPath,
    record.reference_audio_path,
    readPath(record, ['file', 'path']),
    readPath(record, ['audio', 'path'])
  );
  const directFilename = firstString(
    record.storedFilename,
    record.stored_filename,
    record.filename,
    record.fileName,
    record.file_name,
    record.storedName,
    record.stored_name,
    readPath(record, ['file', 'filename']),
    readPath(record, ['file', 'name']),
    readPath(record, ['audio', 'filename']),
    readPath(record, ['referenceAudio', 'filename']),
    readPath(record, ['reference_audio', 'filename'])
  );

  return safeBasename(directFilename) ?? safeBasename(pathValue) ?? (isProbablyFilename(descriptor.id) ? safeBasename(descriptor.id) : undefined);
};

const originalFilenameFromDescriptor = (descriptor: VoiceDescriptor) => {
  const record = descriptorRecord(descriptor);
  return safeBasename(
    firstString(
      record.originalFilename,
      record.original_filename,
      record.uploadFilename,
      record.upload_filename,
      record.sourceFilename,
      record.source_filename,
      readPath(record, ['metadata', 'originalFilename']),
      readPath(record, ['metadata', 'original_filename']),
      readPath(record, ['file', 'originalFilename']),
      readPath(record, ['file', 'originalname']),
      readPath(record, ['upload', 'filename'])
    )
  );
};

const descriptorPathBasename = (descriptor: VoiceDescriptor) => {
  const record = descriptorRecord(descriptor);
  return safeBasename(
    firstString(
      record.path,
      record.filePath,
      record.file_path,
      record.referencePath,
      record.reference_path,
      readPath(record, ['file', 'path']),
      readPath(record, ['audio', 'path'])
    )
  );
};

const descriptorActiveFlag = (descriptor: VoiceDescriptor) => {
  const record = descriptorRecord(descriptor);
  return firstBoolean(
    record.active,
    record.isActive,
    record.is_active,
    record.selected,
    record.isSelected,
    record.is_selected,
    record.current,
    record.default,
    readPath(record, ['state', 'active']),
    readPath(record, ['metadata', 'active'])
  );
};

const descriptorCreatedAt = (descriptor: VoiceDescriptor) => {
  const record = descriptorRecord(descriptor);
  return firstString(record.createdAt, record.created_at, record.uploadedAt, record.uploaded_at, readPath(record, ['file', 'createdAt']));
};

const descriptorModifiedAt = (descriptor: VoiceDescriptor) => {
  const record = descriptorRecord(descriptor);
  return firstString(record.modifiedAt, record.modified_at, record.updatedAt, record.updated_at, readPath(record, ['file', 'modifiedAt']));
};

const descriptorSizeBytes = (descriptor: VoiceDescriptor) => {
  const record = descriptorRecord(descriptor);
  return firstNumber(record.sizeBytes, record.size_bytes, record.bytes, record.size, readPath(record, ['file', 'sizeBytes']));
};

const descriptorDurationSeconds = (descriptor: VoiceDescriptor) => {
  const record = descriptorRecord(descriptor);
  return firstNumber(
    record.durationSeconds,
    record.duration_seconds,
    record.duration,
    readPath(record, ['audio', 'durationSeconds']),
    readPath(record, ['audio', 'duration_seconds'])
  );
};

const getDescriptorMatchKeys = (descriptor: VoiceReferenceDescriptor) =>
  uniqueStrings([
    descriptor.id,
    descriptor.storedFilename,
    descriptor.originalFilename,
    descriptor.displayName,
    descriptor.path,
    safeBasename(descriptor.id)
  ]).map((value) => value.toLowerCase());

const metadataCandidatesFromUploadResult = (uploadResult: unknown) => {
  const strings: string[] = [];
  collectStrings(uploadResult, strings);
  return uniqueStrings(strings.flatMap((value) => [value, safeBasename(value)])).map((value) => value.toLowerCase());
};

const findUploadedDescriptor = (
  beforeReferences: VoiceReferenceDescriptor[],
  afterReferences: VoiceReferenceDescriptor[],
  uploadResult: unknown
) => {
  const resultCandidates = metadataCandidatesFromUploadResult(uploadResult);
  if (resultCandidates.length > 0) {
    const matched = afterReferences.find((descriptor) =>
      getDescriptorMatchKeys(descriptor).some((key) => resultCandidates.includes(key))
    );
    if (matched) return matched;
  }

  const beforeIds = new Set(beforeReferences.map((descriptor) => descriptor.id));
  const newReferences = afterReferences.filter((descriptor) => !beforeIds.has(descriptor.id));
  return newReferences.length === 1 ? newReferences[0] : null;
};

const parseState = (payload: unknown): VoiceReferenceState => {
  const record = asRecord(payload);
  if (!record || record.version !== 1) return defaultState();
  const referencesRecord = asRecord(record.references) ?? {};
  const references: Record<string, StoredReferenceMetadata> = {};

  for (const [id, metadata] of Object.entries(referencesRecord)) {
    const item = asRecord(metadata);
    if (!item) continue;
    const cleanId = cleanString(item.id) ?? cleanString(id);
    if (!cleanId) continue;
    references[cleanId] = {
      id: cleanId,
      originalFilename: safeBasename(item.originalFilename),
      displayName: cleanString(item.displayName)?.slice(0, 180),
      storedFilename: safeBasename(item.storedFilename),
      uploadedAt: cleanString(item.uploadedAt),
      lastSeenAt: cleanString(item.lastSeenAt)
    };
  }

  return {
    version: 1,
    selectedReferenceId: cleanString(record.selectedReferenceId),
    references,
    updatedAt: cleanString(record.updatedAt)
  };
};

const loadState = async () => {
  if (cachedState) return cachedState;
  try {
    const text = await fs.readFile(stateFilePath, 'utf8');
    cachedState = parseState(JSON.parse(text));
    return cachedState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        {
          path: stateFilePath,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        'Could not read voice reference metadata state; continuing with empty state'
      );
    }
    cachedState = defaultState();
    return cachedState;
  }
};

const saveState = async (state: VoiceReferenceState) => {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString()
  } satisfies VoiceReferenceState;
  await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
  const temporaryPath = `${stateFilePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, stateFilePath);
  cachedState = nextState;
  return nextState;
};

const mergeMetadata = async (descriptor: VoiceReferenceDescriptor, metadata: Omit<StoredReferenceMetadata, 'id'>) => {
  const state = await loadState();
  const existing = state.references[descriptor.id] ?? { id: descriptor.id };
  state.references[descriptor.id] = {
    ...existing,
    ...metadata,
    id: descriptor.id,
    originalFilename: metadata.originalFilename ?? existing.originalFilename,
    displayName: metadata.displayName ?? existing.displayName,
    storedFilename: metadata.storedFilename ?? existing.storedFilename ?? descriptor.storedFilename,
    lastSeenAt: new Date().toISOString()
  };
  await saveState(state);
};

export const normalizeVoiceReferences = (
  voiceDescriptors: VoiceDescriptorsResponse,
  state: VoiceReferenceState = defaultState()
): VoiceReferencesResponse => {
  const rawReferences = voiceDescriptors.voices.map((descriptor) => {
    const stateMetadata = state.references[descriptor.id];
    const storedFilename = stateMetadata?.storedFilename ?? storedFilenameFromDescriptor(descriptor);
    const originalFilename = stateMetadata?.originalFilename ?? originalFilenameFromDescriptor(descriptor);
    const rawRecord = descriptorRecord(descriptor);
    const descriptorDisplayName = firstString(
      rawRecord.displayName,
      rawRecord.display_name,
      rawRecord.label,
      rawRecord.title,
      descriptor.label,
      rawRecord.name,
      rawRecord.voice
    );
    const displayName = sanitizeDisplayName(
      stateMetadata?.displayName ?? originalFilename ?? descriptorDisplayName ?? storedFilename ?? descriptor.id,
      descriptor.id
    );
    const isActive = descriptorActiveFlag(descriptor);

    return {
      id: descriptor.id,
      displayName,
      originalFilename,
      storedFilename,
      path: descriptorPathBasename(descriptor),
      sizeBytes: descriptorSizeBytes(descriptor),
      durationSeconds: descriptorDurationSeconds(descriptor),
      createdAt: stateMetadata?.uploadedAt ?? descriptorCreatedAt(descriptor),
      modifiedAt: descriptorModifiedAt(descriptor),
      provider: descriptor.provider,
      model: descriptor.model,
      language: descriptor.language,
      description: descriptor.description,
      type: descriptor.type,
      isActive,
      isSelected: state.selectedReferenceId === descriptor.id,
      canDelete: true,
      source: stateMetadata ? 'bear-castle' : 'voice-vm',
      raw: descriptor.raw
    } satisfies VoiceReferenceDescriptor;
  });

  const activeReference = rawReferences.find((reference) => reference.isActive) ?? null;
  const activeReferenceKnown = activeReference !== null;
  const selectedReference = rawReferences.find((reference) => reference.id === state.selectedReferenceId) ?? null;

  // Bear Castle's persisted selection is the first source of truth because /api/speak sends it
  // as VoiceVM's `voice` field. VoiceVM active/current flags are only a fallback when no app
  // selection exists, so the UI can show one unambiguous Loaded reference.
  const loadedReference = selectedReference ?? activeReference;
  const loadedReferenceKnown = loadedReference !== null;
  const references = rawReferences.map((reference) => ({
    ...reference,
    isLoaded: loadedReference?.id === reference.id,
    canDelete: loadedReference?.id !== reference.id
  }));
  const normalizedLoadedReference = references.find((reference) => reference.id === loadedReference?.id) ?? null;
  const normalizedActiveReference = references.find((reference) => reference.id === activeReference?.id) ?? null;
  const normalizedSelectedReference = references.find((reference) => reference.id === selectedReference?.id) ?? null;

  return {
    references,
    loadedReference: normalizedLoadedReference,
    loadedReferenceKnown,
    activeReference: normalizedActiveReference,
    selectedReference: normalizedSelectedReference,
    activeReferenceKnown,
    selection: {
      mode: 'bear-castle-tts-voice',
      canSelect: true,
      activeReferenceExposedByVoiceVm: activeReferenceKnown,
      activeReferenceKnown,
      loadedReferenceKnown,
      loadedReferenceId: normalizedLoadedReference?.id,
      loadedReferenceDisplayName: normalizedLoadedReference?.displayName,
      selectedReferenceId: normalizedSelectedReference?.id,
      selectedReferenceDisplayName: normalizedSelectedReference?.displayName,
      selectedReferencePersistsIn: 'bear-castle',
      ttsSpeakField: 'voice'
    },
    deletion: {
      mode: 'voice-vm-reference-audio-delete',
      canDelete: true,
      supportedBySuppliedVoiceVmContract: false,
      blocksLoadedReferenceDelete: true,
      clearsBearCastleSelection: false,
      clearsBearCastleMetadata: true
    },
    raw: voiceDescriptors.raw
  };
};

export const getVoiceReferences = async () => {
  const state = await loadState();
  const descriptors = await listVoiceDescriptors();
  const normalized = normalizeVoiceReferences(descriptors, state);

  if (state.selectedReferenceId && !normalized.selectedReference) {
    logger.warn(
      { selectedReferenceId: state.selectedReferenceId },
      'Selected voice reference is no longer listed by VoiceVM; clearing Bear Castle selection'
    );
    delete state.selectedReferenceId;
    await saveState(state);
    return normalizeVoiceReferences(descriptors, state);
  }

  return normalized;
};

const validateReferenceId = (referenceId: string, code = 'VOICE_REFERENCE_ID_REQUIRED') => {
  const id = cleanString(referenceId);
  if (!id || id.length > 240 || hasControlCharacters(id)) {
    throw new ApiError(400, 'A valid reference id is required.', code);
  }
  return id;
};

const findCurrentReference = async (referenceId: string) => {
  const id = validateReferenceId(referenceId);
  const references = await getVoiceReferences();
  const reference = references.references.find((item) => item.id === id);
  if (!reference) {
    throw new ApiError(404, 'That voice reference is not available from VoiceVM.', 'VOICE_REFERENCE_NOT_FOUND');
  }
  return reference;
};

export const selectVoiceReference = async (referenceId: string) => {
  const reference = await findCurrentReference(referenceId);

  const state = await loadState();
  state.selectedReferenceId = reference.id;
  const existing = state.references[reference.id] ?? { id: reference.id };
  state.references[reference.id] = {
    ...existing,
    id: reference.id,
    displayName: existing.displayName ?? reference.displayName,
    originalFilename: existing.originalFilename ?? reference.originalFilename,
    storedFilename: existing.storedFilename ?? reference.storedFilename,
    lastSeenAt: new Date().toISOString()
  };
  await saveState(state);

  return getVoiceReferences();
};

export const deleteVoiceReference = async (referenceId: string) => {
  const id = validateReferenceId(referenceId);
  const beforeReferences = await getVoiceReferences();
  const reference = beforeReferences.references.find((item) => item.id === id);
  if (!reference) {
    throw new ApiError(404, 'That voice reference is not available from VoiceVM.', 'VOICE_REFERENCE_NOT_FOUND');
  }

  if (beforeReferences.loadedReference?.id === reference.id) {
    throw new ApiError(
      409,
      'Loaded reference cannot be deleted. Load another reference before deleting this one.',
      'VOICE_REFERENCE_LOADED_DELETE_BLOCKED'
    );
  }

  const deleteResult = await deleteReferenceAudio({
    id: reference.id,
    storedFilename: reference.storedFilename,
    path: reference.path,
    raw: reference.raw
  });

  const postDeleteReferences = await getVoiceReferences();
  const stillListed = postDeleteReferences.references.some((item) => item.id === reference.id);

  if (stillListed) {
    logger.warn(
      { referenceId: reference.id, displayName: reference.displayName, routeSource: deleteResult.routeSource },
      'VoiceVM accepted the reference delete request, but the descriptor is still returned by /voices'
    );
    throw new ApiError(
      502,
      `VoiceVM accepted the delete request for ${reference.displayName}, but /voices still lists it. The reference was not removed.`,
      'REFERENCE_AUDIO_DELETE_NOT_CONFIRMED',
      { referenceId: reference.id, route: deleteResult.route, routeSource: deleteResult.routeSource }
    );
  }

  const state = await loadState();
  const selectedReferenceCleared = state.selectedReferenceId === reference.id;
  delete state.references[reference.id];
  if (selectedReferenceCleared) delete state.selectedReferenceId;
  await saveState(state);

  logger.info(
    {
      referenceId: reference.id,
      displayName: reference.displayName,
      routeSource: deleteResult.routeSource
    },
    'Voice reference audio deleted through VoiceVM'
  );

  return {
    result: deleteResult.result,
    deletedReferenceId: reference.id,
    deletedReference: reference,
    selectedReferenceCleared,
    stillListed: false,
    references: await getVoiceReferences(),
    message: `Reference audio deleted: ${reference.displayName}.`
  };
};

export const getSelectedVoiceReferenceIdForTts = async () => {
  const state = await loadState();
  return state.selectedReferenceId;
};

export const uploadAndRememberReferenceAudio = async (
  buffer: Buffer,
  originalFilenameInput: string,
  contentType = 'audio/wav',
  options: UploadReferenceAudioOptions = {}
) => {
  const originalFilename = sanitizeOriginalFilename(originalFilenameInput, 'reference.wav');
  const displayName = sanitizeDisplayName(options.displayName, originalFilename);
  const before = await getVoiceReferences();
  const previousLoadedReferenceId = before.loadedReference?.id;
  const uploadResult = await uploadReferenceAudio(buffer, originalFilename, contentType);
  const afterDescriptors = await listVoiceDescriptors();
  let state = await loadState();
  const after = normalizeVoiceReferences(afterDescriptors, state);
  const uploadedReference = findUploadedDescriptor(before.references, after.references, uploadResult);

  if (uploadedReference) {
    await mergeMetadata(uploadedReference, {
      originalFilename,
      displayName,
      storedFilename: uploadedReference.storedFilename,
      uploadedAt: new Date().toISOString()
    });
  } else {
    logger.warn(
      {
        originalFilename,
        beforeCount: before.references.length,
        afterCount: after.references.length,
        uploadResultKeys: Object.keys(asRecord(uploadResult) ?? {}).slice(0, 12)
      },
      'Reference audio uploaded but Bear Castle could not map the VoiceVM response to a /voices descriptor'
    );
  }

  if (!before.selectedReference && previousLoadedReferenceId) {
    state = await loadState();
    if (!state.selectedReferenceId) {
      state.selectedReferenceId = previousLoadedReferenceId;
      await saveState(state);
    }
  }

  return {
    result: uploadResult,
    uploadedReferenceId: uploadedReference?.id,
    references: await getVoiceReferences(),
    mappedOriginalFilename: Boolean(uploadedReference),
    message: uploadedReference
      ? `Reference audio uploaded: ${displayName}.`
      : `Reference audio uploaded, but VoiceVM did not return enough information to match it to a listed descriptor. Refresh /voices and load it if it appears.`
  };
};

export const resetVoiceReferenceStateCacheForTests = () => {
  cachedState = null;
};

export const setVoiceReferenceStateFilePathForTests = (nextPath: string) => {
  stateFilePath = nextPath;
  cachedState = null;
};

export const readVoiceReferenceStateForTests = async () => loadState();
