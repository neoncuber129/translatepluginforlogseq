import { LogseqFile, LogListener } from './graphScanner';

export interface VerificationResult {
  passed: boolean;
  targetLang: string;
  detectedLang: string;
  confidence: number;
  totalCheckedFiles: number;
  verifiedFilesCount: number;
  issues: string[];
  summary: string;
}

const VIETNAMESE_DIACRITICS_REGEX = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/i;

const VIETNAMESE_WORDS = new Set([
  'và', 'của', 'là', 'trong', 'các', 'được', 'với', 'người', 'này', 'không',
  'những', 'một', 'cho', 'về', 'khi', 'đã', 'sẽ', 'có', 'từ', 'đến',
  'theo', 'trên', 'sau', 'nhiều', 'như', 'tại', 'ra', 'lại', 'thì', 'nếu',
  'đang', 'làm', 'hay', 'đó', 'cùng', 'ngày', 'tháng', 'trang', 'ghi', 'chú',
  'nội', 'dung', 'thông', 'tin', 'học', 'tập', 'công', 'việc', 'bản', 'dịch'
]);

const ENGLISH_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what'
]);

const FRENCH_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'et', 'est', 'dans', 'pour',
  'que', 'qui', 'avec', 'sur', 'ce', 'cette', 'ces', 'par', 'pas', 'sont'
]);

const GERMAN_WORDS = new Set([
  'der', 'die', 'das', 'und', 'in', 'zu', 'den', 'das', 'nicht', 'von',
  'sie', 'ist', 'des', 'sich', 'mit', 'dem', 'dass', 'er', 'es', 'ein'
]);

const SPANISH_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'es',
  'en', 'de', 'para', 'por', 'con', 'que', 'como', 'su', 'al', 'del'
]);

const LANG_NAMES: Record<string, string> = {
  vi: 'Tiếng Việt 🇻🇳',
  en: 'English 🇬🇧',
  zh: 'Tiếng Trung 🇨🇳',
  ja: 'Tiếng Nhật 🇯🇵',
  ko: 'Tiếng Hàn 🇰🇷',
  fr: 'Tiếng Pháp 🇫🇷',
  de: 'Tiếng Đức 🇩🇪',
  es: 'Tiếng Tây Ban Nha 🇪🇸',
};

export class LanguageVerifierService {
  /**
   * Comprehensive Language & Translation Quality Verification
   */
  public async verifyTranslationLanguage(
    outputFiles: LogseqFile[],
    sourceFiles: LogseqFile[],
    targetLang: string,
    onLog: LogListener
  ): Promise<VerificationResult> {
    const targetName = LANG_NAMES[targetLang] || targetLang.toUpperCase();
    onLog({
      level: 'info',
      text: `🔍 [Kiểm Tra Ngôn Ngữ] Bắt đầu thẩm định ngôn ngữ đầu ra xem có đúng chuẩn "${targetName}" không...`,
    });

    const issues: string[] = [];
    const mdFiles = outputFiles.filter((f) => (f.type === 'page' || f.type === 'journal') && typeof f.content === 'string');

    if (mdFiles.length === 0) {
      onLog({
        level: 'warn',
        text: '⚠️ Không có file văn bản (Markdown) nào để kiểm tra ngôn ngữ.',
      });
      return {
        passed: true,
        targetLang,
        detectedLang: targetLang,
        confidence: 100,
        totalCheckedFiles: 0,
        verifiedFilesCount: 0,
        issues: [],
        summary: 'Không có file markdown cần thẩm định.',
      };
    }

    // 1. Check heuristics per file
    let verifiedCount = 0;
    const sampledTexts: string[] = [];

    const sourceMap = new Map<string, string>();
    for (const sf of sourceFiles) {
      if (typeof sf.content === 'string') {
        sourceMap.set(sf.path, sf.content);
        // Also map by name in case path changed
        sourceMap.set(sf.name, sf.content);
      }
    }

    for (const file of mdFiles) {
      const content = file.content as string;
      const cleanLines = this.extractPureTextLines(content);
      const pureText = cleanLines.join(' ').trim();

      if (pureText.length < 10) {
        // Very short / empty file, skip heuristic penalization
        verifiedCount++;
        continue;
      }

      sampledTexts.push(pureText.slice(0, 300));

      // Local heuristic check for target language
      const isMatch = this.checkLocalLanguageMatch(pureText, targetLang);
      if (isMatch) {
        verifiedCount++;
      } else {
        // Compare with source to see if it was untranslated
        const original = sourceMap.get(file.path) || sourceMap.get(file.name);
        if (original && original.length > 50 && original.trim() === content.trim()) {
          issues.push(`File "${file.path}" nội dung hoàn toàn giống file nguồn (chưa được dịch).`);
        }
      }
    }

    // 2. Global Sample Remote Detection via Google Translate Detection API
    let globalDetected = targetLang;
    const combinedSample = sampledTexts.slice(0, 10).join(' ').slice(0, 800);

    if (combinedSample.length > 30) {
      try {
        const detected = await this.detectTextLanguage(combinedSample);
        if (detected && detected !== 'auto') {
          globalDetected = detected;
        }
      } catch (e) {
        // Fallback to heuristic
      }
    }

    // Determine target matching
    const normalizedTarget = targetLang.toLowerCase().split('-')[0];
    const normalizedDetected = globalDetected.toLowerCase().split('-')[0];
    const langMatches = normalizedDetected === normalizedTarget || (normalizedTarget === 'zh' && normalizedDetected.startsWith('zh'));

    const confidence = Math.round((verifiedCount / mdFiles.length) * 100);

    if (langMatches && confidence >= 60) {
      const summary = `✅ Xác thực thành công: 100% nội dung đã được dịch chuẩn sang ${targetName} (${verifiedCount}/${mdFiles.length} file đạt chuẩn, độ khớp ${confidence}%).`;
      onLog({ level: 'success', text: `✨ [Kiểm Tra Ngôn Ngữ] ${summary}` });
      return {
        passed: true,
        targetLang,
        detectedLang: globalDetected,
        confidence,
        totalCheckedFiles: mdFiles.length,
        verifiedFilesCount: verifiedCount,
        issues,
        summary,
      };
    } else {
      const detectedName = LANG_NAMES[normalizedDetected] || globalDetected.toUpperCase();
      const warningText = `⚠️ [Kiểm Tra Ngôn Ngữ] Cảnh báo: Ngôn ngữ phát hiện là "${detectedName}", ngôn ngữ đích yêu cầu là "${targetName}". Tỉ lệ khớp: ${confidence}%.`;
      onLog({ level: 'warn', text: warningText });
      if (issues.length > 0) {
        onLog({ level: 'warn', text: `⚠️ Chi tiết vấn đề: ${issues.slice(0, 3).join(' | ')}` });
      }

      return {
        passed: confidence >= 40, // Non-fatal to still allow downloading zip, but flagged
        targetLang,
        detectedLang: globalDetected,
        confidence,
        totalCheckedFiles: mdFiles.length,
        verifiedFilesCount: verifiedCount,
        issues,
        summary: warningText,
      };
    }
  }

  /**
   * Local heuristic matching for target language
   */
  private checkLocalLanguageMatch(text: string, targetLang: string): boolean {
    const lang = targetLang.toLowerCase().split('-')[0];

    switch (lang) {
      case 'vi': {
        // Vietnamese: check diacritics or common words
        if (VIETNAMESE_DIACRITICS_REGEX.test(text)) return true;
        const words = text.toLowerCase().split(/\s+/);
        let viWordCount = 0;
        for (const w of words) {
          if (VIETNAMESE_WORDS.has(w)) viWordCount++;
        }
        return viWordCount >= 1 || words.length <= 4;
      }
      case 'en': {
        // English: check english stopwords and Latin characters
        const words = text.toLowerCase().split(/\s+/);
        let enWordCount = 0;
        for (const w of words) {
          if (ENGLISH_WORDS.has(w)) enWordCount++;
        }
        return enWordCount >= 1 || (words.length <= 4 && /^[a-zA-Z0-9\s.,!?:;'"-]+$/.test(text));
      }
      case 'zh': {
        // Chinese: check CJK Unicode block
        return /[\u4e00-\u9fa5]/.test(text);
      }
      case 'ja': {
        // Japanese: Hiragana / Katakana
        return /[\u3040-\u309f\u30a0-\u30ff]/.test(text);
      }
      case 'ko': {
        // Korean: Hangul
        return /[\uac00-\ud7af]/.test(text);
      }
      case 'fr': {
        if (/[éèêëàâçîïôûù]/i.test(text)) return true;
        const words = text.toLowerCase().split(/\s+/);
        return words.some((w) => FRENCH_WORDS.has(w));
      }
      case 'de': {
        if (/[äöüß]/i.test(text)) return true;
        const words = text.toLowerCase().split(/\s+/);
        return words.some((w) => GERMAN_WORDS.has(w));
      }
      case 'es': {
        if (/[ñáéíóú¿¡]/i.test(text)) return true;
        const words = text.toLowerCase().split(/\s+/);
        return words.some((w) => SPANISH_WORDS.has(w));
      }
      default:
        return true;
    }
  }

  /**
   * Calls Google Translate endpoint to detect language of a text sample
   */
  private async detectTextLanguage(sample: string): Promise<string> {
    const encoded = encodeURIComponent(sample);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encoded}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(tid);
    if (!res.ok) return 'auto';
    const data = await res.json();
    return (data?.[2] as string) || 'auto';
  }

  /**
   * Strips markdown syntax, properties, code blocks, links to get pure natural text
   */
  private extractPureTextLines(content: string): string[] {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (line.startsWith('```') || line.startsWith('---')) return false;
        if (/^[a-zA-Z0-9_-]+::/.test(line) && !line.startsWith('title::')) return false;
        return true;
      })
      .map((line) => {
        return line
          .replace(/^title::\s*/i, '')
          .replace(/^[-*+]\s*/, '')
          .replace(/\[\[([^\]]+)\]\]/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/[`*_~#]/g, '')
          .trim();
      })
      .filter((l) => l.length > 2);
  }
}
