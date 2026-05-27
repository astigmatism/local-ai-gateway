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
      source: 'bear-castle'
    });
    expect(response.selectedReference?.displayName).toBe('eric-test-reference.wav');
    expect(response.activeReferenceKnown).toBe(false);
  });

  it('surfaces VoiceVM active flags without inventing active state', async () => {
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
    expect(response.references.map((reference) => reference.isActive)).toEqual([undefined, true]);
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
});
