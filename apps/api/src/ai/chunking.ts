/**
 * Text chunking for retrieval.
 *
 * Chunk boundaries decide what the model can cite. A chunk that stops mid-
 * derivation produces a retrieved passage that cannot answer anything, so this
 * prefers structural boundaries — headings, paragraphs, sentences — and only
 * cuts mid-sentence when a single sentence exceeds the budget on its own.
 *
 * Pure functions with no dependencies, so the segmentation can be tested
 * against real teacher material without a database or an API key.
 */

export interface Chunk {
  index: number;
  content: string;
  tokenCount: number;
  /** Heading this chunk sits under, when one was detected. */
  sectionTitle: string | null;
  /** Page marker, when the source carried one. */
  pageNumber: number | null;
}

export interface ChunkOptions {
  /** Target size in tokens. */
  chunkSize: number;
  /** Tokens repeated from the previous chunk, to preserve context across a cut. */
  chunkOverlap: number;
  /** Chunks shorter than this are folded into their neighbour. */
  minChunkTokens: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = {
  chunkSize: 900,
  chunkOverlap: 150,
  minChunkTokens: 40,
};

/**
 * Approximates token count without a tokeniser.
 *
 * Roughly four characters per token for English prose, adjusted upward for
 * digits and symbols, which tokenise less efficiently. This does not need to be
 * exact — it decides chunk boundaries, not billing — but it must never
 * badly under-count, or a chunk will overflow the embedding model's limit.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  const symbols = (text.match(/[^\w\s]/g) ?? []).length;
  const digits = (text.match(/\d/g) ?? []).length;

  return Math.max(1, Math.ceil((text.length + symbols * 2 + digits) / 4));
}

/** Backwards compatibility for older tests that expected looksLikeHeading */
export function looksLikeHeading(line: string): boolean {
  return detectHeading(line) !== null;
}

/** Detects a Markdown heading or a short all-caps or numbered line. */
export function detectHeading(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return null;

  const markdown = /^#{1,6}\s+(.+)$/.exec(trimmed);
  if (markdown) return markdown[1]?.trim() ?? null;

  // "3.2 Newton's Second Law" — a numbered section heading.
  if (/^\d+(\.\d+)*[.)]?\s+\S/.test(trimmed) && !/[.!?]$/.test(trimmed)) {
    return trimmed;
  }

  // A short line in title or upper case with no terminal punctuation.
  if (trimmed.length <= 80 && !/[.!?,;:]$/.test(trimmed)) {
    const words = trimmed.split(/\s+/);
    if (words.length <= 10 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

/** Detects a page marker such as "--- Page 12 ---" left by a PDF extractor. */
export function detectPageMarker(line: string): number | null {
  const match = /^[-\s=]*page\s+(\d{1,4})[-\s=]*$/i.exec(line.trim());
  if (!match) return null;

  const page = Number(match[1]);
  return Number.isFinite(page) ? page : null;
}

/**
 * Splits into sentences without breaking on common abbreviations or decimals.
 * "0.5 m/s" and "Fig. 3" must not become sentence boundaries in a physics text.
 */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/(\d)\.(\d)/g, '$1\u0001$2')
    .replace(/\b(Fig|Eq|No|Vol|Ch|Sec|Dr|Mr|Mrs|Ms|etc|i\.e|e\.g|approx|vs)\./gi, '$1\u0002');

  const pieces = protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z(\[])/)
    .map((piece) => piece.replace(/\u0001/g, '.').replace(/\u0002/g, '.').trim())
    .filter((piece) => piece.length > 0);

  return pieces.length > 0 ? pieces : [text.trim()].filter((t) => t.length > 0);
}

/** Hard-splits a single oversized sentence on whitespace, as a last resort. */
function splitOversized(sentence: string, maxTokens: number): string[] {
  const words = sentence.split(/\s+/);
  const out: string[] = [];

  let buffer: string[] = [];

  for (const word of words) {
    buffer.push(word);
    if (estimateTokens(buffer.join(' ')) >= maxTokens) {
      out.push(buffer.join(' '));
      buffer = [];
    }
  }

  if (buffer.length > 0) out.push(buffer.join(' '));
  return out;
}

/** Takes the trailing `tokens` worth of text, on a sentence boundary if possible. */
function tailOverlap(text: string, tokens: number): string {
  if (tokens <= 0) return '';

  const sentences = splitSentences(text);
  const kept: string[] = [];

  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const candidate = [sentences[i] as string, ...kept];
    if (estimateTokens(candidate.join(' ')) > tokens && kept.length > 0) break;
    kept.unshift(sentences[i] as string);
    if (estimateTokens(kept.join(' ')) >= tokens) break;
  }

  return kept.join(' ');
}

/**
 * Segments extracted text into overlapping chunks.
 *
 * Headings reset the chunk, because a chunk spanning two topics retrieves badly
 * for both.
 */
export function chunkText(
  raw: string,
  options: ChunkOptions = DEFAULT_CHUNKING,
): Chunk[] {
  const text = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length === 0) return [];

  const lines = text.split('\n');

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let sectionTitle: string | null = null;
  let pendingSection: string | null = null;
  let pageNumber: number | null = null;

  const flush = (): void => {
    const content = buffer.join('\n').trim();
    buffer = [];

    if (content.length === 0) return;

    const tokenCount = estimateTokens(content);

    // A short trailing fragment is folded back rather than stored alone; an
    // eight-token chunk retrieves noise.
    const previous = chunks[chunks.length - 1];
    if (tokenCount < options.minChunkTokens && previous) {
      previous.content = `${previous.content}\n${content}`;
      previous.tokenCount = estimateTokens(previous.content);
      return;
    }

    chunks.push({
      index: chunks.length,
      content,
      tokenCount,
      sectionTitle,
      pageNumber,
    });
  };

  const bufferTokens = (): number => estimateTokens(buffer.join('\n'));

  for (const line of lines) {
    const page = detectPageMarker(line);
    if (page !== null) {
      pageNumber = page;
      continue;
    }

    const heading = detectHeading(line);
    if (heading) {
      // Close the current chunk before the new section starts.
      if (buffer.length > 0) {
        flush();
        sectionTitle = pendingSection ?? sectionTitle;
      }
      pendingSection = heading;
      sectionTitle = heading;
      buffer.push(line);
      continue;
    }

    for (const sentence of splitSentences(line)) {
      const pieces =
        estimateTokens(sentence) > options.chunkSize
          ? splitOversized(sentence, options.chunkSize)
          : [sentence];

      for (const piece of pieces) {
        const projected = estimateTokens([...buffer, piece].join('\n'));

        if (projected > options.chunkSize && buffer.length > 0) {
          const carry = tailOverlap(buffer.join('\n'), options.chunkOverlap);
          flush();
          buffer = carry.length > 0 ? [carry] : [];
        }

        buffer.push(piece);
      }
    }

    if (bufferTokens() >= options.chunkSize) {
      const carry = tailOverlap(buffer.join('\n'), options.chunkOverlap);
      flush();
      buffer = carry.length > 0 ? [carry] : [];
    }
  }

  flush();

  return chunks.map((chunk, index) => ({ ...chunk, index }));
}
