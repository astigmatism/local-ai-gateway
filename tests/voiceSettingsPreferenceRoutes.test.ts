import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

describe('voice settings preference routes', () => {
  it('keeps per-user TTS preference endpoints separate from admin lifecycle/default-provider mutations', () => {
    const source = readSource('server/src/routes/settingsVoice.ts');
    const preferenceStart = source.indexOf("settingsVoiceRouter.get(\n  '/preference'");
    const nextHealthRoute = source.indexOf("settingsVoiceRouter.get(\n  '/health'", preferenceStart);
    const preferenceRoutes = source.slice(preferenceStart, nextHealthRoute);

    expect(preferenceStart).toBeGreaterThan(-1);
    expect(preferenceRoutes).toContain('getUserTtsPreference(requireAuthenticatedUserId(req))');
    expect(preferenceRoutes).toContain('updateUserTtsPreference(requireAuthenticatedUserId(req)');
    expect(preferenceRoutes).not.toContain('requireAdmin');
    expect(preferenceRoutes).not.toContain('updateVoiceTtsConfig');
    expect(preferenceRoutes).not.toContain('loadVoiceTtsModel');
    expect(preferenceRoutes).not.toContain('unloadVoiceTtsModel');
  });
});
