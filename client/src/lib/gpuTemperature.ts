export type GpuTemperatureSeverity = 'normal' | 'warm' | 'hot' | 'emergency';

export const GPU_TEMPERATURE_MIN_C = 20;
export const GPU_TEMPERATURE_WARM_C = 55;
export const GPU_TEMPERATURE_HOT_C = 75;
export const GPU_TEMPERATURE_EMERGENCY_C = 90;
export const GPU_TEMPERATURE_MAX_C = GPU_TEMPERATURE_EMERGENCY_C;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const getGpuTemperaturePercentage = (temperatureC: number) =>
  clamp(
    ((temperatureC - GPU_TEMPERATURE_MIN_C) / (GPU_TEMPERATURE_MAX_C - GPU_TEMPERATURE_MIN_C)) * 100,
    0,
    100
  );

export const getGpuTemperatureSeverity = (temperatureC: number): GpuTemperatureSeverity => {
  if (temperatureC >= GPU_TEMPERATURE_EMERGENCY_C) return 'emergency';
  if (temperatureC >= GPU_TEMPERATURE_HOT_C) return 'hot';
  if (temperatureC >= GPU_TEMPERATURE_WARM_C) return 'warm';
  return 'normal';
};
