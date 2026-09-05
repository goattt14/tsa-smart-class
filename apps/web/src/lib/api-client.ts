import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import { env } from '@/config/env';
import { tokenStore } from './token-store';

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

interface RetryConfig extends InternalAxiosRequestConfig {
  _retryCount?: number;
  _refreshAttempted?: boolean;
}

const MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Render's free tier suspends idle services, so the first request after a quiet
 * period can take ~50s while the container wakes. Rather than surfacing a
 * failure, retry with backoff and let the UI show a "waking up" state.
 */
type ColdStartListener = (waking: boolean) => void;
const coldStartListeners = new Set<ColdStartListener>();
let coldStartActive = false;

export function onColdStart(listener: ColdStartListener): () => void {
  coldStartListeners.add(listener);
  return () => coldStartListeners.delete(listener);
}

function setColdStart(waking: boolean): void {
  if (coldStartActive === waking) return;
  coldStartActive = waking;
  coldStartListeners.forEach((listener) => listener(waking));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.random() * 400; // jitter avoids synchronised retries
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: env.apiBaseUrl,
  timeout: 60_000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ---------------------------------------------------------------- refresh queue
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  refreshPromise ??= (async () => {
    try {
      const { data } = await axios.post<{ success: boolean; data: { accessToken: string } }>(
        `${env.apiBaseUrl}/auth/refresh`,
        {},
        { withCredentials: true, timeout: 20_000 },
      );
      const token = data?.data?.accessToken ?? null;
      tokenStore.set(token);
      return token;
    } catch {
      tokenStore.clear();
      window.dispatchEvent(new CustomEvent('tsa:session-expired'));
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

apiClient.interceptors.response.use(
  (response) => {
    setColdStart(false);
    return response;
  },
  async (error: AxiosError<ApiErrorBody>) => {
    const config = error.config as RetryConfig | undefined;

    // 401 -> try exactly one silent refresh, then replay the original request.
    if (
      error.response?.status === 401 &&
      config &&
      !config._refreshAttempted &&
      !config.url?.includes('/auth/refresh') &&
      !config.url?.includes('/auth/login')
    ) {
      config._refreshAttempted = true;
      const token = await refreshAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
        return apiClient.request(config);
      }
    }

    const status = error.response?.status;
    const isNetworkError = !error.response;
    const canRetry =
      config &&
      (isNetworkError || (status !== undefined && RETRYABLE_STATUS.has(status))) &&
      (config.method ?? 'get').toLowerCase() !== 'post';

    if (canRetry) {
      const attempt = config._retryCount ?? 0;
      if (attempt < MAX_RETRIES) {
        config._retryCount = attempt + 1;
        if (isNetworkError || status === 502 || status === 503) setColdStart(true);
        await sleep(backoffMs(attempt));
        return apiClient.request(config);
      }
    }

    setColdStart(false);

    if (error.response?.data?.error) {
      const { code, message, details, requestId } = error.response.data.error;
      throw new ApiError(error.response.status, code, message, details, requestId);
    }
    if (isNetworkError) {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.',
      );
    }
    throw new ApiError(
      error.response?.status ?? 500,
      'UNEXPECTED_ERROR',
      error.message || 'Something went wrong.',
    );
  },
);

// ---------------------------------------------------------------- typed helpers
interface Envelope<T> {
  success: true;
  data: T;
}

export async function apiGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const { data } = await apiClient.get<Envelope<T>>(url, config);
  return data.data;
}

export async function apiPost<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const { data } = await apiClient.post<Envelope<T>>(url, body, config);
  return data.data;
}

export async function apiPatch<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const { data } = await apiClient.patch<Envelope<T>>(url, body, config);
  return data.data;
}

export async function apiPut<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
  const { data } = await apiClient.put<Envelope<T>>(url, body, config);
  return data.data;
}

export async function apiDelete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  const { data } = await apiClient.delete<Envelope<T>>(url, config);
  return data.data;
}
