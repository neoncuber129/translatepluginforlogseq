import { TranslationService } from './translator';

export interface DefinitionItem {
  definition: string;
  example?: string;
}

export interface DictionaryResult {
  word: string;
  phonetic?: string;
  audio?: string;
  partOfSpeech?: string;
  translation: string;
  definitions: DefinitionItem[];
  contextSentence?: string;
}

export class DictionaryService {
  private translator: TranslationService;
  private cache: Map<string, DictionaryResult> = new Map();

  constructor(translator: TranslationService) {
    this.translator = translator;
  }

  public getCached(word: string): DictionaryResult | undefined {
    return this.cache.get(word.trim().toLowerCase());
  }

  public async lookupWord(wordOrPhrase: string, contextSentence?: string): Promise<DictionaryResult> {
    const query = wordOrPhrase.trim();
    if (!query) {
      throw new Error('Word or phrase cannot be empty');
    }

    const lower = query.toLowerCase();
    if (this.cache.has(lower)) {
      const cached = this.cache.get(lower)!;
      if (contextSentence) cached.contextSentence = contextSentence;
      return cached;
    }

    // Translate the phrase/word to target language
    const translation = await this.translator.translateText(query);

    let phonetic = '';
    let audio = '';
    let partOfSpeech = '';
    const definitions: DefinitionItem[] = [];

    // Attempt to fetch detailed dictionary data if query is a single word
    if (!query.includes(' ')) {
      try {
        const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(query.toLowerCase())}`;
        const res = await fetch(dictUrl);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            const entry = data[0];
            phonetic = entry.phonetic || entry.phonetics?.find((p: any) => p.text)?.text || '';
            
            const audioObj = entry.phonetics?.find((p: any) => p.audio && p.audio.length > 0);
            if (audioObj) audio = audioObj.audio;

            if (entry.meanings && entry.meanings.length > 0) {
              const primaryMeaning = entry.meanings[0];
              partOfSpeech = primaryMeaning.partOfSpeech || '';

              if (Array.isArray(primaryMeaning.definitions)) {
                for (const d of primaryMeaning.definitions.slice(0, 3)) {
                  definitions.push({
                    definition: d.definition,
                    example: d.example,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('[Dictionary] Free Dictionary API fetch failed, fallback to translation only', err);
      }
    }

    // Always provide high-quality Google TTS audio endpoint
    if (!audio) {
      audio = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(query)}`;
    }

    const result: DictionaryResult = {
      word: query,
      phonetic,
      audio,
      partOfSpeech,
      translation,
      definitions,
      contextSentence,
    };

    this.cache.set(lower, result);
    return result;
  }
}
