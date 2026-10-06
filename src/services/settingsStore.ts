import { TranslationEngine } from './translator';

export interface GraphPair {
  id: string;
  name: string;
  sourcePath: string;
  destPath: string;
  targetLang?: string;
  engine?: TranslationEngine;
  apiKey?: string;
}

export interface PluginSettings {
  engine: TranslationEngine;
  sourceLang: string;
  targetLang: string;
  apiKey: string;
  translatePageLinks: boolean;
  translateProperties: boolean;
  clearCache: boolean;
  autoPopupOnSelect: boolean;
  hoverTranslateOnHover: boolean;
  lastSourcePath?: string;
  lastDestPath?: string;
  savedPairs: GraphPair[];
  activePairId?: string;
}

const SETTINGS_KEY = 'logseq_translator_settings_v1';

const defaultSettings: PluginSettings = {
  engine: 'google',
  sourceLang: 'auto',
  targetLang: 'vi',
  apiKey: '',
  translatePageLinks: true,
  translateProperties: false,
  clearCache: false,
  autoPopupOnSelect: true,
  hoverTranslateOnHover: true,
  lastSourcePath: '',
  lastDestPath: '',
  savedPairs: [],
  activePairId: '',
};

export class SettingsStore {
  private settings: PluginSettings;

  constructor() {
    this.settings = this.loadFromStorage();
  }

  private loadFromStorage(): PluginSettings {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        return { ...defaultSettings, ...JSON.parse(raw) };
      }
    } catch (err) {
      console.warn('[SettingsStore] Failed to parse settings from localStorage:', err);
    }
    return { ...defaultSettings };
  }

  public getSettings(): PluginSettings {
    return { ...this.settings };
  }

  public updateSettings(partial: Partial<PluginSettings>): PluginSettings {
    this.settings = { ...this.settings, ...partial };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
      if (typeof logseq !== 'undefined' && logseq.updateSettings) {
        logseq.updateSettings(this.settings);
      }
    } catch (err) {
      console.warn('[SettingsStore] Failed to save settings:', err);
    }
    return { ...this.settings };
  }

  public addPair(pair: Omit<GraphPair, 'id'>): PluginSettings {
    const newPair: GraphPair = {
      ...pair,
      id: `pair_${Date.now()}`,
    };
    const pairs = [...this.settings.savedPairs, newPair];
    return this.updateSettings({ savedPairs: pairs, activePairId: newPair.id });
  }

  public updatePairTargetLang(id: string, targetLang: string): PluginSettings {
    const pairs = this.settings.savedPairs.map((p) => (p.id === id ? { ...p, targetLang } : p));
    return this.updateSettings({ savedPairs: pairs });
  }

  public removePair(id: string): PluginSettings {
    const pairs = this.settings.savedPairs.filter((p) => p.id !== id);
    const activePairId = this.settings.activePairId === id ? (pairs[0]?.id || '') : this.settings.activePairId;
    return this.updateSettings({ savedPairs: pairs, activePairId });
  }
}
