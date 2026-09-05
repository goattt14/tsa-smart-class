import { AiFeature } from '@prisma/client';
import OpenAI from 'openai';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { AiError } from './types';

export interface Transcript {
  text: string;
  /** 0..1, or null when the provider does not report one. */
  confidence: number | null;
  provider: string;
  durationSec: number | null;
  language: string | null;
}

/**
 * Transcribes a spoken answer.
 *
 * Two paths are supported and neither is assumed. Browsers with the Web Speech
 * API transcribe on the device and post the text, which costs nothing and
 * keeps the audio off the server entirely — the better option where it works.
 * Where it does not, the audio is uploaded and sent to Whisper.
 *
 * With no key configured, transcription fails clearly rather than silently
 * returning an empty string that would be scored as a non-answer.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  options: { language?: string | undefined; userId?: string | null } = {},
): Promise<Transcript> {
  if (!env.OPENAI_API_KEY) {
    throw new AiError(
      'Server-side transcription needs OPENAI_API_KEY. Use the browser speech recogniser, or type the answer instead.',
      'NO_CREDENTIALS',
      false,
    );
  }

  const started = Date.now();
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.AI_TIMEOUT_MS });

  try {
    const file = new File([new Uint8Array(audio)], filename, {
      type: filename.endsWith('.webm') ? 'audio/webm' : 'audio/mpeg',
    });

    const response = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      // Indian students routinely mix English and Hindi mid-sentence. Leaving
      // the language unset lets the recogniser handle that rather than forcing
      // everything through an English model that mangles the Hindi.
      ...(options.language ? { language: options.language } : {}),
      response_format: 'verbose_json',
    });

    const verbose = response as unknown as {
      text: string;
      duration?: number;
      language?: string;
      segments?: { no_speech_prob?: number }[];
    };

    // Whisper reports no confidence directly. The inverse of its no-speech
    // probability is the closest honest proxy available.
    const segments = verbose.segments ?? [];
    const confidence =
      segments.length > 0
        ? 1 -
          segments.reduce((sum, s) => sum + (s.no_speech_prob ?? 0), 0) / segments.length
        : null;

    await recordSttUsage(options.userId ?? null, Date.now() - started, true);

    return {
      text: verbose.text.trim(),
      confidence: confidence === null ? null : Math.round(confidence * 100) / 100,
      provider: 'whisper-1',
      durationSec: verbose.duration ? Math.round(verbose.duration) : null,
      language: verbose.language ?? null,
    };
  } catch (error) {
    await recordSttUsage(options.userId ?? null, Date.now() - started, false);
    logger.error({ err: error }, 'transcription failed');

    throw new AiError(
      'That recording could not be transcribed. Try again, or type the answer.',
      'STT_FAILED',
      true,
    );
  }
}

async function recordSttUsage(
  userId: string | null,
  latencyMs: number,
  success: boolean,
): Promise<void> {
  try {
    await prisma.aiUsageLog.create({
      data: {
        userId,
        feature: AiFeature.VIVA_EVALUATION,
        provider: 'OPENAI',
        model: 'whisper-1',
        latencyMs,
        success,
        ...(success ? {} : { errorCode: 'STT_FAILED' }),
      },
    });
  } catch {
    // Usage accounting must never break the feature it accounts for.
  }
}

export interface SpeechQuality {
  wordCount: number;
  /** True when there is too little to evaluate as an answer. */
  tooShort: boolean;
  /** True when the recogniser was too unsure to judge the content fairly. */
  unintelligible: boolean;
  note: string | null;
}

/**
 * Judges whether a transcript is worth evaluating.
 *
 * This distinction protects the student. An answer marked wrong because the
 * microphone failed is an injustice, so a garbled transcript is reported as
 * unintelligible and excluded from the score rather than being fed to the
 * evaluator and coming back as a zero.
 */
export function assessSpeech(transcript: string, confidence: number | null): SpeechQuality {
  const words = transcript.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return { wordCount: 0, tooShort: true, unintelligible: false, note: 'Nothing was recorded.' };
  }

  if (confidence !== null && confidence < 0.45) {
    return {
      wordCount: words.length,
      tooShort: false,
      unintelligible: true,
      note: 'The recording was too unclear to mark. This has not been counted against you.',
    };
  }

  if (words.length < 4) {
    return {
      wordCount: words.length,
      tooShort: true,
      unintelligible: false,
      note: 'That was very short. Try to explain your reasoning aloud.',
    };
  }

  return { wordCount: words.length, tooShort: false, unintelligible: false, note: null };
}
