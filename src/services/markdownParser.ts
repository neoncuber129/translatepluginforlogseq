import { TranslationService } from './translator';

export interface ParseOptions {
  translatePageLinks?: boolean; // Whether to translate [[Page Names]]
  translateProperties?: boolean; // Whether to translate property values like title::
  cleanDestination?: boolean; // Whether to wipe old dest pages/journals before sync (1:1 clean sync)
}

interface SegmentJob {
  lineIndex: number;
  type: 'title' | 'property' | 'bullet' | 'text';
  indent: string;
  prefix: string;
  originalText: string;
  processedText: string;
  placeholders: { token: string; value: string }[];
}

export class LogseqMarkdownParser {
  private translator: TranslationService;
  private pageMap: Map<string, string>; // Maps original page title -> translated page title

  constructor(translator: TranslationService) {
    this.translator = translator;
    this.pageMap = new Map<string, string>();
  }

  public setPageMapping(map: Map<string, string>) {
    this.pageMap = map;
  }

  public clearPageMapping() {
    this.pageMap.clear();
  }

  public getPageMapping(): Map<string, string> {
    return this.pageMap;
  }

  /**
   * Fast Batched Logseq Markdown Document Translator.
   */
  public async translateDocument(content: string, options: ParseOptions = {}): Promise<string> {
    const lines = content.split(/\r?\n/);
    const resultLines: string[] = new Array(lines.length);

    let inCodeBlock = false;
    let codeBlockBuffer: string[] = [];

    const jobs: SegmentJob[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Handle Code Block ``` ... ```
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          codeBlockBuffer.push(line);
          resultLines[i] = codeBlockBuffer.join('\n');
          codeBlockBuffer = [];
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
          codeBlockBuffer.push(line);
          resultLines[i] = '';
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockBuffer.push(line);
        resultLines[i] = '';
        continue;
      }

      // Handle Logseq Properties (key:: value)
      const propertyMatch = line.match(/^(\s*)([a-zA-Z0-9_-]+)::\s*(.*)$/);
      if (propertyMatch) {
        const indent = propertyMatch[1];
        const key = propertyMatch[2];
        const val = propertyMatch[3];

        if (key.toLowerCase() === 'title' && options.translatePageLinks) {
          const prep = this.prepareSegment(val, options);
          jobs.push({
            lineIndex: i,
            type: 'title',
            indent,
            prefix: `${key}:: `,
            originalText: val,
            processedText: prep.processed,
            placeholders: prep.placeholders,
          });
        } else if (['id', 'collapsed', 'heading', 'background-color', 'created-at', 'updated-at', 'icon', 'file'].includes(key.toLowerCase())) {
          resultLines[i] = line;
        } else {
          if (options.translateProperties && val.trim()) {
            const prep = this.prepareSegment(val, options);
            jobs.push({
              lineIndex: i,
              type: 'property',
              indent,
              prefix: `${key}:: `,
              originalText: val,
              processedText: prep.processed,
              placeholders: prep.placeholders,
            });
          } else {
            resultLines[i] = line;
          }
        }
        continue;
      }

      // Handle Regular Bullet Lines or Plain Text Lines
      if (!line.trim()) {
        resultLines[i] = line;
        continue;
      }

      const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const indent = listMatch[1];
        const bullet = listMatch[2];
        const textContent = listMatch[3];
        const prep = this.prepareSegment(textContent, options);

        jobs.push({
          lineIndex: i,
          type: 'bullet',
          indent,
          prefix: `${bullet} `,
          originalText: textContent,
          processedText: prep.processed,
          placeholders: prep.placeholders,
        });
      } else {
        const prep = this.prepareSegment(line, options);
        jobs.push({
          lineIndex: i,
          type: 'text',
          indent: '',
          prefix: '',
          originalText: line,
          processedText: prep.processed,
          placeholders: prep.placeholders,
        });
      }
    }

    // Collect texts that actually need translation
    const textsToTranslate: string[] = [];
    const jobTranslationIndices: number[] = [];

    for (let k = 0; k < jobs.length; k++) {
      const job = jobs[k];
      const pureText = job.processedText.replace(/__LOGSEQ_TOK_\d+__/g, '').trim();
      if (!pureText) {
        // Only contains placeholders, skip HTTP call
        resultLines[job.lineIndex] = `${job.indent}${job.prefix}${this.restorePlaceholders(job.processedText, job.placeholders)}`;
      } else {
        textsToTranslate.push(job.processedText);
        jobTranslationIndices.push(k);
      }
    }

    // Perform batch translation
    if (textsToTranslate.length > 0) {
      const translatedBatch = await this.translator.translateBatch(textsToTranslate);

      for (let m = 0; m < translatedBatch.length; m++) {
        const jobIdx = jobTranslationIndices[m];
        const job = jobs[jobIdx];
        const translatedRaw = translatedBatch[m] || job.processedText;
        const finalContent = this.restorePlaceholders(translatedRaw, job.placeholders);

        if (job.type === 'title') {
          this.pageMap.set(job.originalText.trim(), finalContent.trim());
        }

        resultLines[job.lineIndex] = `${job.indent}${job.prefix}${finalContent}`;
      }
    }

    // Clean empty slots resulting from multiline code blocks
    return resultLines.filter((l) => l !== undefined && l !== null).join('\n');
  }

  /**
   * Prepares a text segment by protecting markdown syntax, tags, math, images, attributes, and links.
   * Also normalises asset paths so the destination graph finds them correctly.
   */
  private prepareSegment(text: string, options: ParseOptions): { processed: string; placeholders: { token: string; value: string }[] } {
    if (!text || !text.trim()) return { processed: text, placeholders: [] };

    const placeholders: { token: string; value: string }[] = [];
    let counter = 0;

    const addPlaceholder = (val: string): string => {
      const token = `__LOGSEQ_TOK_${counter++}__`;
      placeholders.push({ token, value: val });
      return token;
    };

    let processed = text;

    // 1. Math block $$ ... $$
    processed = processed.replace(/\$\$[\s\S]*?\$\$/g, (m) => addPlaceholder(m));

    // 2. Inline math $ ... $
    processed = processed.replace(/\$[^\$\n]+\$/g, (m) => addPlaceholder(m));

    // 3. Inline code ` ... `
    processed = processed.replace(/`[^`\n]+`/g, (m) => addPlaceholder(m));

    // 4. Protect Logseq macros/renderers {{renderer ...}} or {{embed ...}}
    processed = processed.replace(/\{\{[\s\S]*?\}\}/g, (m) => addPlaceholder(m));

    // 5. Protect HTML <img> tags
    processed = processed.replace(/<img[^>]*>/gi, (m) => addPlaceholder(m));

    // 6. Protect Logseq double bracket image embeds: ![[...]]
    processed = processed.replace(/!\[\[[^\]]+\]\]/g, (m) => addPlaceholder(m));

    // 7. Protect Markdown images + optional Logseq attribute blocks {:height ..., :width ...}:
    //    e.g. ![alt](../assets/image.png){:height 100, :width 200}
    processed = processed.replace(/!\[[\s\S]*?\]\([^\)]*\)(\{:[^}]+\})?/g, (m) => addPlaceholder(m));

    // 8. Protect remaining Logseq attribute blocks {:height ..., :width ...}
    processed = processed.replace(/\{:[^}]+\}/g, (m) => addPlaceholder(m));

    // 9. Protect bare asset paths ../assets/... or assets/...
    processed = processed.replace(/(\.\.\/)?assets\/[^\s)\}\]]+/gi, (m) => addPlaceholder(m));

    // 8. Page Links [[Page Name]]
    processed = processed.replace(/\[\[([^\]]+)\]\]/g, (match, pageTitle) => {
      if (options.translatePageLinks) {
        const mapped = this.pageMap.get(pageTitle.trim());
        if (mapped) return `[[${mapped}]]`;
      }
      return addPlaceholder(match);
    });

    // 9. Tags #tag or #[[tag]]
    processed = processed.replace(/#\[\[([^\]]+)\]\]/g, (match) => addPlaceholder(match));
    processed = processed.replace(/#[a-zA-Z0-9_\-\/]+/g, (match) => addPlaceholder(match));

    // 10. URLs http:// or https://
    processed = processed.replace(/https?:\/\/[^\s<>()]+/g, (match) => addPlaceholder(match));

    return { processed, placeholders };
  }

  /**
   * Restores syntax placeholders back into translated text.
   */
  private restorePlaceholders(translatedText: string, placeholders: { token: string; value: string }[]): string {
    let restored = translatedText;
    for (const p of placeholders) {
      // Fuzzy regex handles spaces inserted around tokens by translation engines
      const fuzzyRegex = new RegExp(p.token.split('_').join('\\s*_?\\s*'), 'gi');
      restored = restored.replace(fuzzyRegex, () => p.value);
    }
    return restored;
  }
}
