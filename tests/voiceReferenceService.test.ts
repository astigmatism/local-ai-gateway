import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceDescriptorsResponse } from '../server/src/services/voiceClient.js';
import type { VoiceReferenceState } from '../server/src/services/voiceReferenceService.js';

const stubEnv = () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('VOICE_BASE_URL', 'http://192.168.1.8:8000');
};

const loadService = async () => {
  vi.resetModules();
  stubEnv();
  return import('../server/src/services/voiceReferenceService.js');
};

afterEach(() => {
  vi.unmock('../server/src/services/voiceClient.js');
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('voice reference normalization', () => {
  it('prefers persisted original upload filenames over generated VoiceVM names', async () => {
    const { normalizeVoiceReferences } = await loadService();
    const state: VoiceReferenceState = {
      version: 1,
      selectedReferenceId: 'reference_20260527_abc123.wav',
      references: {
        'reference_20260527_abc123.wav': {
          id: 'reference_20260527_abc123.wav',
          originalFilename: 'eric-test-reference.wav',
          displayName: 'eric-test-reference.wav',
          storedFilename: 'reference_20260527_abc123.wav',
          uploadedAt: '2026-05-27T07:00:00.000Z'
        }
      }
    };
    const descriptors: VoiceDescriptorsResponse = {
      voices: [
        {
          id: 'reference_20260527_abc123.wav',
          label: 'reference_20260527_abc123.wav',
          type: 'reference',
          raw: {
            id: 'reference_20260527_abc123.wav',
            filename: 'reference_20260527_abc123.wav',
            created_at: '2026-05-27T07:01:00.000Z'
          }
        }
      ],
      raw: {}
    };

    const response = normalizeVoiceReferences(descriptors, state);

    expect(response.references[0]).toMatchObject({
      id: 'reference_20260527_abc123.wav',
      displayName: 'eric-test-reference.wav',
      originalFilename: 'eric-test-reference.wav',
      storedFilename: 'reference_20260527_abc123.wav',
      isSelected: true,
      isLoaded: true,
      canDelete: false,
      source: 'bear-castle'
    });
    expect(response.selectedReference?.displayName).toBe('eric-test-reference.wav');
    expect(response.loadedReference?.displayName).toBe('eric-test-reference.wav');
    expect(response.loadedReferenceKnown).toBe(true);
    expect(response.activeReferenceKnown).toBe(false);
  });

  it('surfaces VoiceVM active flags as the loaded fallback when Bear Castle has no selection', async () => {
    const { normalizeVoiceReferences } = await loadService();
    const descriptors: VoiceDescriptorsResponse = {
      voices: [
        { id: 'a.wav', label: 'a.wav', raw: { id: 'a.wav', filename: 'a.wav' } },
        { id: 'b.wav', label: 'b.wav', raw: { id: 'b.wav', filename: 'b.wav', active: true } }
      ],
      raw: {}
    };

    const response = normalizeVoiceReferences(descriptors);

    expect(response.activeReferenceKnown).toBe(true);
    expect(response.activeReference?.id).toBe('b.wav');
    expect(response.loadedReference?.id).toBe('b.wav');
    expect(response.references.map((reference) => reference.isActive)).toEqual([undefined, true]);
    expect(response.references.map((reference) => reference.isLoaded)).toEqual([false, true]);
    expect(response.references.map((reference) => reference.canDelete)).toEqual([true, false]);
  });

  it('uses Bear Castle selection as the loaded source of truth over a different VoiceVM active flag', async () => {
    const { normalizeVoiceReferences } = await loadService();
    const state: VoiceReferenceState = {
      version: 1,
      selectedReferenceId: 'a.wav',
      references: {}
    };
    const descriptors: VoiceDescriptorsResponse = {
      voices: [
        { id: 'a.wav', label: 'a.wav', raw: { id: 'a.wav', filename: 'a.wav' } },
        { id: 'b.wav', label: 'b.wav', raw: { id: 'b.wav', filename: 'b.wav', active: true } }
      ],
      raw: {}
    };

    const response = normalizeVoiceReferences(descriptors, state);

    expect(response.loadedReference?.id).toBe('a.wav');
    expect(response.selectedReference?.id).toBe('a.wav');
    expect(response.activeReference?.id).toBe('b.wav');
    expect(response.references.map((reference) => [reference.id, reference.isLoaded])).toEqual([
      ['a.wav', true],
      ['b.wav', false]
    ]);
  });

  it('sanitizes upload display names and path-like filenames', async () => {
    const { sanitizeDisplayName, sanitizeOriginalFilename } = await loadService();

    expect(sanitizeOriginalFilename('../../Eric Reference.wav')).toBe('Eric Reference.wav');
    expect(sanitizeOriginalFilename('C:\\Users\\Eric\\voice.wav')).toBe('voice.wav');
    expect(sanitizeDisplayName('../Friendly Name.wav')).toBe('Friendly Name.wav');
  });

  it('persists selected reference state in the Bear Castle sidecar file', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bear-voice-reference-'));
    const statePath = path.join(stateDir, 'voice-reference-state.json');
    const service = await loadService();
    service.setVoiceReferenceStateFilePathForTests(statePath);

    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        selectedReferenceId: 'reference_1.wav',
        references: {
          'reference_1.wav': {
            id: 'reference_1.wav',
            originalFilename: 'eric-reference.wav',
            displayName: 'eric-reference.wav'
          }
        }
      })
    );
    service.resetVoiceReferenceStateCacheForTests();

    await expect(service.getSelectedVoiceReferenceIdForTts()).resolves.toBe('reference_1.wav');
  });

  it('deletes a listed non-loaded reference and preserves the loaded selection', async () => {
    vi.resetModules();
    stubEnv();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bear-voice-reference-delete-'));
    const statePath = path.join(stateDir, 'voice-reference-state.json');
    const selectedDescriptor = {
      id: 'reference_1.wav',
      label: 'reference_1.wav',
      raw: { id: 'reference_1.wav', filename: 'reference_1.wav' }
    };
    const deletedDescriptor = {
      id: 'reference_2.wav',
      label: 'reference_2.wav',
      raw: { id: 'reference_2.wav', filename: 'reference_2.wav' }
    };
    const listVoiceDescriptors = vi
      .fn()
      .mockResolvedValueOnce({ voices: [selectedDescriptor, deletedDescriptor], raw: {} })
      .mockResolvedValueOnce({ voices: [selectedDescriptor], raw: {} })
      .mockResolvedValueOnce({ voices: [selectedDescriptor], raw: {} });
    const deleteReferenceAudio = vi.fn(async () => ({
      result: { ok: true },
      route: '/api/tts/reference-audio/reference_2.wav',
      routeSource: 'bear-castle-fallback' as const
    }));

    vi.doMock('../server/src/services/voiceClient.js', () => ({
      listVoiceDescriptors,
      uploadReferenceAudio: vi.fn(),
      deleteReferenceAudio
    }));

    const service = await import('../server/src/services/voiceReferenceService.js');
    service.setVoiceReferenceStateFilePathForTests(statePath);
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        selectedReferenceId: 'reference_1.wav',
        references: {
          'reference_1.wav': {
            id: 'reference_1.wav',
            originalFilename: 'eric-reference.wav',
            displayName: 'Eric reference',
            storedFilename: 'reference_1.wav'
          },
          'reference_2.wav': {
            id: 'reference_2.wav',
            originalFilename: 'delete-me.wav',
            displayName: 'Delete me',
            storedFilename: 'reference_2.wav'
          }
        }
      })
    );
    service.resetVoiceReferenceStateCacheForTests();

    const result = await service.deleteVoiceReference('reference_2.wav');
    const state = await service.readVoiceReferenceStateForTests();

    expect(deleteReferenceAudio).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reference_2.wav', storedFilename: 'reference_2.wav' })
    );
    expect(result.deletedReferenceId).toBe('reference_2.wav');
    expect(result.selectedReferenceCleared).toBe(false);
    expect(result.stillListed).toBe(false);
    expect(state.selectedReferenceId).toBe('reference_1.wav');
    expect(state.references['reference_1.wav']).toBeDefined();
    expect(state.references['reference_2.wav']).toBeUndefined();
  });

  it('rejects deletion of the loaded reference before calling VoiceVM', async () => {
    vi.resetModules();
    stubEnv();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bear-voice-reference-delete-loaded-'));
    const statePath = path.join(stateDir, 'voice-reference-state.json');
    const listVoiceDescriptors = vi.fn(async () => ({
      voices: [
        {
          id: 'reference_1.wav',
          label: 'reference_1.wav',
          raw: { id: 'reference_1.wav', filename: 'reference_1.wav' }
        }
      ],
      raw: {}
    }));
    const deleteReferenceAudio = vi.fn();

    vi.doMock('../server/src/services/voiceClient.js', () => ({
      listVoiceDescriptors,
      uploadReferenceAudio: vi.fn(),
      deleteReferenceAudio
    }));

    const service = await import('../server/src/services/voiceReferenceService.js');
    service.setVoiceReferenceStateFilePathForTests(statePath);
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        selectedReferenceId: 'reference_1.wav',
        references: {}
      })
    );
    service.resetVoiceReferenceStateCacheForTests();

    await expect(service.deleteVoiceReference('reference_1.wav')).rejects.toMatchObject({
      statusCode: 409,
      code: 'VOICE_REFERENCE_LOADED_DELETE_BLOCKED'
    });
    expect(deleteReferenceAudio).not.toHaveBeenCalled();
  });

  it('reports a clear failure when VoiceVM accepts delete but still lists the reference', async () => {
    vi.resetModules();
    stubEnv();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bear-voice-reference-delete-still-listed-'));
    const statePath = path.join(stateDir, 'voice-reference-state.json');
    const descriptor = {
      id: 'reference_2.wav',
      label: 'reference_2.wav',
      raw: { id: 'reference_2.wav', filename: 'reference_2.wav' }
    };
    const listVoiceDescriptors = vi
      .fn()
      .mockResolvedValueOnce({ voices: [descriptor], raw: {} })
      .mockResolvedValueOnce({ voices: [descriptor], raw: {} });
    const deleteReferenceAudio = vi.fn(async () => ({
      result: { ok: true },
      route: '/api/tts/reference-audio/reference_2.wav',
      routeSource: 'bear-castle-fallback' as const
    }));

    vi.doMock('../server/src/services/voiceClient.js', () => ({
      listVoiceDescriptors,
      uploadReferenceAudio: vi.fn(),
      deleteReferenceAudio
    }));

    const service = await import('../server/src/services/voiceReferenceService.js');
    service.setVoiceReferenceStateFilePathForTests(statePath);
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        references: {
          'reference_2.wav': {
            id: 'reference_2.wav',
            originalFilename: 'delete-me.wav',
            displayName: 'Delete me',
            storedFilename: 'reference_2.wav'
          }
        }
      })
    );
    service.resetVoiceReferenceStateCacheForTests();

    await expect(service.deleteVoiceReference('reference_2.wav')).rejects.toMatchObject({
      statusCode: 502,
      code: 'REFERENCE_AUDIO_DELETE_NOT_CONFIRMED'
    });
    const state = await service.readVoiceReferenceStateForTests();
    expect(state.references['reference_2.wav']).toBeDefined();
  });

  it('uploads without loading the new reference and preserves the previous loaded fallback', async () => {
    vi.resetModules();
    stubEnv();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bear-voice-reference-upload-'));
    const statePath = path.join(stateDir, 'voice-reference-state.json');
    const oldActiveDescriptor = {
      id: 'old.wav',
      label: 'old.wav',
      raw: { id: 'old.wav', filename: 'old.wav', active: true }
    };
    const oldInactiveDescriptor = {
      id: 'old.wav',
      label: 'old.wav',
      raw: { id: 'old.wav', filename: 'old.wav' }
    };
    const uploadedDescriptor = {
      id: 'new.wav',
      label: 'new.wav',
      raw: { id: 'new.wav', filename: 'new.wav', active: true }
    };
    const listVoiceDescriptors = vi
      .fn()
      .mockResolvedValueOnce({ voices: [oldActiveDescriptor], raw: {} })
      .mockResolvedValueOnce({ voices: [oldInactiveDescriptor, uploadedDescriptor], raw: {} })
      .mockResolvedValueOnce({ voices: [oldInactiveDescriptor, uploadedDescriptor], raw: {} });
    const uploadReferenceAudio = vi.fn(async () => ({ id: 'new.wav', filename: 'new.wav' }));

    vi.doMock('../server/src/services/voiceClient.js', () => ({
      listVoiceDescriptors,
      uploadReferenceAudio,
      deleteReferenceAudio: vi.fn()
    }));

    const service = await import('../server/src/services/voiceReferenceService.js');
    service.setVoiceReferenceStateFilePathForTests(statePath);
    service.resetVoiceReferenceStateCacheForTests();

    const result = await service.uploadAndRememberReferenceAudio(Buffer.from('RIFF'), 'new.wav', 'audio/wav', {
      displayName: 'New reference'
    });
    const state = await service.readVoiceReferenceStateForTests();

    expect(uploadReferenceAudio).toHaveBeenCalledWith(expect.any(Buffer), 'new.wav', 'audio/wav');
    expect(result.uploadedReferenceId).toBe('new.wav');
    expect(result.references.loadedReference?.id).toBe('old.wav');
    expect(result.references.references.find((reference) => reference.id === 'new.wav')?.isLoaded).toBe(false);
    expect(state.selectedReferenceId).toBe('old.wav');
  });
});
