import axios from 'axios';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface TelemetryEntry {
  data: unknown | null;
  last_success_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  stale: boolean;
}

export interface ServiceTelemetryStatus {
  health: TelemetryEntry;
  gpu: TelemetryEntry;
}

export interface GatewayTelemetryStatus {
  llm: ServiceTelemetryStatus;
  voice: ServiceTelemetryStatus;
}

type ServiceName = 'llm' | 'voice';
type EndpointName = 'health' | 'gpu';

type MutableTelemetryEntry = Omit<TelemetryEntry, 'stale'>;

const makeEntry = (): MutableTelemetryEntry => ({
  data: null,
  last_success_at: null,
  last_checked_at: null,
  last_error: null
});

const trimUrl = (url: string) => url.replace(/\/+$/, '');

const errorMessage = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `HTTP ${error.response.status}`;
    }
    if (error.code === 'ECONNABORTED') {
      return `timeout after ${config.telemetry.requestTimeoutMs} ms`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'unknown error';
};

class TelemetryService {
  private readonly state: Record<ServiceName, Record<EndpointName, MutableTelemetryEntry>> = {
    llm: {
      health: makeEntry(),
      gpu: makeEntry()
    },
    voice: {
      health: makeEntry(),
      gpu: makeEntry()
    }
  };

  private timers: NodeJS.Timeout[] = [];
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;

    void this.pollAllHealth();
    void this.pollAllGpu();

    this.timers.push(setInterval(() => void this.pollAllHealth(), config.telemetry.healthPollIntervalMs));
    this.timers.push(setInterval(() => void this.pollAllGpu(), config.telemetry.gpuPollIntervalMs));
  }

  stop() {
    this.timers.forEach((timer) => clearInterval(timer));
    this.timers = [];
    this.started = false;
  }

  getStatus(): GatewayTelemetryStatus {
    return {
      llm: {
        health: this.present(this.state.llm.health),
        gpu: this.present(this.state.llm.gpu)
      },
      voice: {
        health: this.present(this.state.voice.health),
        gpu: this.present(this.state.voice.gpu)
      }
    };
  }

  private present(entry: MutableTelemetryEntry): TelemetryEntry {
    const stale =
      !entry.last_success_at || Date.now() - new Date(entry.last_success_at).getTime() > config.telemetry.staleAfterMs;

    return {
      ...entry,
      stale
    };
  }

  private async pollAllHealth() {
    await Promise.all([
      this.pollEndpoint('llm', 'health', config.llm.monitorBaseUrl),
      this.pollEndpoint('voice', 'health', config.voice.baseUrl)
    ]);
  }

  private async pollAllGpu() {
    await Promise.all([
      this.pollEndpoint('llm', 'gpu', config.llm.monitorBaseUrl),
      this.pollEndpoint('voice', 'gpu', config.voice.baseUrl)
    ]);
  }

  private async pollEndpoint(service: ServiceName, endpoint: EndpointName, baseUrl: string) {
    const entry = this.state[service][endpoint];
    entry.last_checked_at = new Date().toISOString();

    try {
      const response = await axios.get(`${trimUrl(baseUrl)}/${endpoint}`, {
        timeout: config.telemetry.requestTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300
      });

      entry.data = response.data;
      entry.last_success_at = new Date().toISOString();
      entry.last_error = null;
    } catch (error) {
      entry.last_error = errorMessage(error);
      logger.warn({ err: error, service, endpoint, baseUrl }, 'Telemetry poll failed');
    }
  }
}

export const telemetryService = new TelemetryService();
