import { describe, expect, it } from 'vitest';
import {
  getGpuTemperaturePercentage,
  getGpuTemperatureSeverity,
  GPU_TEMPERATURE_EMERGENCY_C,
  GPU_TEMPERATURE_HOT_C,
  GPU_TEMPERATURE_MAX_C,
  GPU_TEMPERATURE_MIN_C,
  GPU_TEMPERATURE_WARM_C
} from '../client/src/lib/gpuTemperature.js';

describe('GPU temperature visual scale', () => {
  it('maps temperatures to severity bands without marking normal values as hot', () => {
    expect(getGpuTemperatureSeverity(40)).toBe('normal');
    expect(getGpuTemperatureSeverity(GPU_TEMPERATURE_WARM_C)).toBe('warm');
    expect(getGpuTemperatureSeverity(60)).toBe('warm');
    expect(getGpuTemperatureSeverity(GPU_TEMPERATURE_HOT_C)).toBe('hot');
    expect(getGpuTemperatureSeverity(80)).toBe('hot');
    expect(getGpuTemperatureSeverity(GPU_TEMPERATURE_EMERGENCY_C)).toBe('emergency');
    expect(getGpuTemperatureSeverity(95)).toBe('emergency');
  });

  it('calculates fill width from the 20C to 90C visual range', () => {
    expect(getGpuTemperaturePercentage(GPU_TEMPERATURE_MIN_C)).toBe(0);
    expect(getGpuTemperaturePercentage(40)).toBeCloseTo(28.57, 2);
    expect(getGpuTemperaturePercentage(55)).toBe(50);
    expect(getGpuTemperaturePercentage(60)).toBeCloseTo(57.14, 2);
    expect(getGpuTemperaturePercentage(80)).toBeCloseTo(85.71, 2);
    expect(getGpuTemperaturePercentage(GPU_TEMPERATURE_MAX_C)).toBe(100);
  });

  it('clamps temperatures outside the visual scale', () => {
    expect(getGpuTemperaturePercentage(10)).toBe(0);
    expect(getGpuTemperaturePercentage(95)).toBe(100);
  });
});
