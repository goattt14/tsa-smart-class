/**
 * Vite inlines these at build time. There is deliberately no localhost
 * fallback: a missing VITE_API_BASE_URL must fail loudly at boot rather than
 * silently shipping a broken production bundle.
 */
interface WebEnv {
  apiBaseUrl: string;
  demoMode: boolean;
  defaultTimezone: string;
  features: {
    proctoring: boolean;
    voiceViva: boolean;
    push: boolean;
  };
  vapidPublicKey: string;
  faceModelBaseUrl: string;
  // Branding - polished to support LoginPage
  APP_NAME: string;
  APP_SHORT_NAME: string;
  APP_TAGLINE: string;
  PRIMARY_COLOR: string;
  SECONDARY_COLOR: string;
  ACCENT_COLOR: string;
  LOGO_URL: string;
}

const flag = (value: string | undefined, fallback = false): boolean =>
  value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

const rawBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

if (!rawBaseUrl) {
  throw new Error(
    'VITE_API_BASE_URL is not set. Add it to apps/web/.env for local work and to the Vercel project settings for deployments.',
  );
}

export const env: WebEnv = {
  apiBaseUrl: rawBaseUrl.replace(/\/+$/, ''),
  demoMode: flag(import.meta.env.VITE_DEMO_MODE as string | undefined, false),
  defaultTimezone: (import.meta.env.VITE_DEFAULT_TIMEZONE as string | undefined) ?? 'Asia/Kolkata',
  features: {
    proctoring: flag(import.meta.env.VITE_ENABLE_PROCTORING as string | undefined, true),
    voiceViva: flag(import.meta.env.VITE_ENABLE_VOICE_VIVA as string | undefined, true),
    push: flag(import.meta.env.VITE_ENABLE_PUSH as string | undefined, true),
  },
  vapidPublicKey: (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '',
  faceModelBaseUrl:
    (import.meta.env.VITE_FACE_MODEL_BASE_URL as string | undefined) ??
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  APP_NAME: (import.meta.env.VITE_APP_NAME as string | undefined) ?? 'The Scholastic Academy',
  APP_SHORT_NAME: (import.meta.env.VITE_APP_SHORT_NAME as string | undefined) ?? 'TSA',
  APP_TAGLINE: (import.meta.env.VITE_APP_TAGLINE as string | undefined) ?? 'strive for success',
  PRIMARY_COLOR: (import.meta.env.VITE_PRIMARY_COLOR as string | undefined) ?? '#5CB82B',
  SECONDARY_COLOR: (import.meta.env.VITE_SECONDARY_COLOR as string | undefined) ?? '#101418',
  ACCENT_COLOR: (import.meta.env.VITE_ACCENT_COLOR as string | undefined) ?? '#E8A317',
  LOGO_URL: (import.meta.env.VITE_LOGO_URL as string | undefined) ?? '/logo.svg',
};
