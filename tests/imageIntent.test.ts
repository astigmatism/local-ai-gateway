import { describe, expect, it } from 'vitest';
import { detectImageIntent } from '../server/src/services/imageIntent.js';

describe('detectImageIntent', () => {
  it.each([
    'Generate an image of a castle in the mountains.',
    'Create a picture of a retro computer desk.',
    'Draw me a bear wearing armor.',
    'Make an image of a Windows 98 gaming setup.',
    'Render a picture of a GPU test bench.',
    'Give me a picture of a fantasy castle.',
    'Can you create artwork of a cyberpunk fox?'
  ])('routes clear image prompt %s to image generation', (prompt) => {
    expect(detectImageIntent(prompt)).toMatchObject({ kind: 'image' });
  });

  it.each([
    'Explain how image generation works.',
    'Write a prompt for an image generator.',
    'What is the best model for generating images?',
    'Describe this image generation bug.',
    'Generate a list of image prompt ideas.',
    'Give me code that displays a picture.',
    "What does 'draw' mean in a graphics API?"
  ])('keeps conceptual prompt %s on chat', (prompt) => {
    expect(detectImageIntent(prompt)).toMatchObject({ kind: 'chat' });
  });

  it('supports /image as a force override and strips the command', () => {
    expect(detectImageIntent('/image a retro Windows 98 gaming PC on a desk')).toMatchObject({
      kind: 'image',
      prompt: 'a retro Windows 98 gaming PC on a desk',
      forcedBy: '/image'
    });
  });

  it('supports /chat as a force override and strips the command', () => {
    expect(detectImageIntent('/chat generate an image prompt for a castle')).toMatchObject({
      kind: 'chat',
      prompt: 'generate an image prompt for a castle',
      forcedBy: '/chat'
    });
  });
});
