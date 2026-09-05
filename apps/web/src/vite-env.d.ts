/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_APP_NAME?: string;
  readonly VITE_APP_SHORT_NAME?: string;
  readonly VITE_APP_TAGLINE?: string;
  readonly VITE_PRIMARY_COLOR?: string;
  readonly VITE_SECONDARY_COLOR?: string;
  readonly VITE_ACCENT_COLOR?: string;
  readonly VITE_LOGO_URL?: string;
  readonly VITE_DEFAULT_TIMEZONE?: string;
  readonly VITE_ENABLE_PROCTORING?: string;
  readonly VITE_ENABLE_VOICE_VIVA?: string;
  readonly VITE_ENABLE_PUSH?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  readonly VITE_FACE_MODEL_BASE_URL?: string;
  readonly VITE_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Minimal Web Speech API surface.
 *
 * Not part of the DOM lib TypeScript ships, and only Chromium browsers expose
 * it (as the prefixed `webkitSpeechRecognition`). Declared narrowly here —
 * just the members the viva recorder actually touches — rather than pulling
 * in a third-party types package for one feature-detected hook.
 */
interface SpeechRecognitionResultEvent extends Event {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: { transcript: string; confidence: number };
    };
  };
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface Window {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
}
