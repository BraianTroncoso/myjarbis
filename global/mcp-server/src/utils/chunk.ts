/**
 * Split long markdown content into smaller chunks for finer-grained storage
 * and FTS5 retrieval. Pure function, no side effects.
 *
 * Strategy (in order):
 *   1. If content is below `threshold`, return a single chunk (no split).
 *   2. Split by H2 headings (`^## `). Text preceding the first H2 becomes
 *      an "intro" chunk; each H2 section becomes its own chunk.
 *   3. If any H2 chunk still exceeds `maxChunkSize`, recursively split it
 *      by H3 (`^### `).
 *   4. If the document has no H2 at all but exceeds `threshold`, fall back
 *      to paragraph-based splitting (blank-line separated blocks, packed
 *      into chunks of roughly `paragraphTargetSize` characters).
 *
 * Slugs are derived from heading text (kebab-case ASCII). Collisions get
 * a numeric suffix (`setup`, `setup-2`). Titles combine the doc title with
 * the heading text (`<docTitle> / <heading>`).
 */

export interface Chunk {
  /** Stable identifier appended to source_path (`workflow.md#<slug>`). Empty
   *  string means "no split happened" — callers should use the original
   *  source_path unchanged. */
  slug: string;
  /** Human-facing title for the chunk row. */
  title: string;
  /** The chunk content (markdown). Includes its own heading line when
   *  split by H2/H3, so the chunk renders correctly on its own. */
  content: string;
}

export interface ChunkOptions {
  /** Below this size (bytes), return a single chunk. Default 4096. */
  threshold?: number;
  /** Re-split H2 chunks that exceed this size by H3. Default 8192. */
  maxChunkSize?: number;
  /** Target size for paragraph-fallback chunks. Default 2000. */
  paragraphTargetSize?: number;
}

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CHUNK_SIZE = 8192;
const DEFAULT_PARAGRAPH_TARGET = 2000;

/** Extract the H1 (`# Title`) or first non-empty line as the doc title. */
function extractDocTitle(content: string, fallback: string): string {
  const h1 = content.match(/^#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim().slice(0, 200);
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 200);
  }
  return fallback;
}

/** Convert a heading string into a kebab-case ASCII slug. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Disambiguate a slug against an in-use set by appending -2, -3, ... */
function uniqueSlug(slug: string, used: Set<string>): string {
  const base = slug || 'section';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

interface RawSection {
  /** Heading text (without leading hashes). Empty for the intro section. */
  heading: string;
  /** Depth of the heading: 2 for ##, 3 for ###. 0 for the intro. */
  depth: number;
  /** Full content including the heading line (when heading is non-empty). */
  body: string;
}

/** Split content into sections by a regex matching the heading line. */
function splitByHeading(content: string, depth: 2 | 3): RawSection[] {
  const marker = '#'.repeat(depth);
  const re = new RegExp(`^${marker}\\s+(.+?)\\s*$`, 'gm');
  const sections: RawSection[] = [];
  const matches: { idx: number; heading: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    matches.push({ idx: m.index, heading: m[1].trim() });
  }
  if (matches.length === 0) {
    return [{ heading: '', depth: 0, body: content }];
  }
  // Intro: anything before the first heading.
  if (matches[0].idx > 0) {
    const intro = content.slice(0, matches[0].idx).trimEnd();
    if (intro.trim().length > 0) {
      sections.push({ heading: '', depth: 0, body: intro });
    }
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : content.length;
    sections.push({
      heading: matches[i].heading,
      depth,
      body: content.slice(start, end).trimEnd(),
    });
  }
  return sections;
}

/** Paragraph-based split: pack blank-line separated blocks until each
 *  bucket is around `target` bytes. Used when no headings exist. */
function splitByParagraphs(content: string, target: number): string[] {
  const paragraphs = content.split(/\n\s*\n/);
  const out: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    const next = current ? `${current}\n\n${p}` : p;
    if (next.length > target && current) {
      out.push(current);
      current = p;
    } else {
      current = next;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

export function chunkMarkdown(content: string, opts: ChunkOptions = {}): Chunk[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxChunkSize = opts.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const paragraphTarget = opts.paragraphTargetSize ?? DEFAULT_PARAGRAPH_TARGET;

  const docTitle = extractDocTitle(content, 'document');

  if (content.length < threshold) {
    return [{ slug: '', title: docTitle, content }];
  }

  const h2Sections = splitByHeading(content, 2);
  const noH2 = h2Sections.length === 1 && h2Sections[0].depth === 0;

  if (noH2) {
    // Fallback: paragraph blocks.
    const parts = splitByParagraphs(content, paragraphTarget);
    const used = new Set<string>();
    return parts.map((body, i) => {
      const slug = uniqueSlug(`part-${i + 1}`, used);
      return {
        slug,
        title: `${docTitle} / part ${i + 1}`,
        content: body,
      };
    });
  }

  const used = new Set<string>();
  const out: Chunk[] = [];
  for (const sec of h2Sections) {
    if (sec.depth === 0) {
      // Intro section before the first ##.
      out.push({
        slug: uniqueSlug('intro', used),
        title: `${docTitle} / intro`,
        content: sec.body,
      });
      continue;
    }
    if (sec.body.length <= maxChunkSize) {
      out.push({
        slug: uniqueSlug(slugify(sec.heading), used),
        title: `${docTitle} / ${sec.heading}`.slice(0, 200),
        content: sec.body,
      });
      continue;
    }
    // Section too large — try H3 split.
    const h3Sections = splitByHeading(sec.body, 3);
    if (h3Sections.length === 1 && h3Sections[0].depth === 0) {
      // No H3 either — fall back to paragraph split inside this section.
      const parts = splitByParagraphs(sec.body, paragraphTarget);
      parts.forEach((body, i) => {
        out.push({
          slug: uniqueSlug(`${slugify(sec.heading)}-${i + 1}`, used),
          title: `${docTitle} / ${sec.heading} (part ${i + 1})`.slice(0, 200),
          content: body,
        });
      });
      continue;
    }
    for (const sub of h3Sections) {
      if (sub.depth === 0) {
        // H2 preamble before first H3.
        out.push({
          slug: uniqueSlug(`${slugify(sec.heading)}-intro`, used),
          title: `${docTitle} / ${sec.heading} / intro`.slice(0, 200),
          content: sub.body,
        });
      } else {
        out.push({
          slug: uniqueSlug(
            `${slugify(sec.heading)}-${slugify(sub.heading)}`,
            used,
          ),
          title: `${docTitle} / ${sec.heading} / ${sub.heading}`.slice(0, 200),
          content: sub.body,
        });
      }
    }
  }

  return out;
}
