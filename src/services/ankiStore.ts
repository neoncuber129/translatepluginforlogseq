export type CardRating = 'again' | 'hard' | 'good' | 'easy';

export interface AnkiCard {
  id: string;
  word: string;
  translation: string;
  phonetic?: string;
  partOfSpeech?: string;
  contextSentence?: string;
  definition?: string;
  deckPath: string; // e.g. "Medical/Cardiology" or "General"
  sourcePage?: string; // e.g. "Medical/Cardiology"
  sourceBlockId?: string;
  tags?: string[];
  repetition: number;
  interval: number; // in days
  easeFactor: number; // default 2.5
  dueDate: string; // ISO date YYYY-MM-DD
  createdAt: string; // ISO timestamp
  lastReviewed?: string;
  status: 'new' | 'learning' | 'mastered';
}

export interface DeckStats {
  total: number;
  dueToday: number;
  newCards: number;
  learning: number;
  mastered: number;
}

export interface DeckNode {
  name: string; // e.g. "Cardiology"
  fullPath: string; // e.g. "Medical/Cardiology"
  total: number;
  dueToday: number;
  newCards: number;
  mastered: number;
  cards: AnkiCard[];
  children: DeckNode[];
}

const STORAGE_KEY = 'logseq_anki_cards_v1';

export class AnkiStore {
  private cards: AnkiCard[] = [];

  constructor() {
    this.loadFromStorage();
  }

  private normalizeDeckPath(path?: string): string {
    if (!path || !path.trim()) return 'Inbox';
    return path
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/|\/$/g, '');
  }

  private loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const loaded: any[] = JSON.parse(raw);
        // Only load intentionally saved cards (exclude temporary lookup items)
        this.cards = loaded
          .filter((c) => c && c.word && c.deckPath !== 'Đã tra' && c.deckPath !== 'Đã tra (Phiên hiện tại)' && !c.isTemporary)
          .map((c) => ({
            ...c,
            deckPath: this.normalizeDeckPath(c.deckPath || c.sourcePage || 'Inbox'),
            tags: Array.isArray(c.tags) ? c.tags : [],
          }));
      }
    } catch (err) {
      console.error('[AnkiStore] Failed to load cards from localStorage:', err);
      this.cards = [];
    }
  }

  private saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cards));
    } catch (err) {
      console.error('[AnkiStore] Failed to save cards to localStorage:', err);
    }
  }

  public getCards(): AnkiCard[] {
    return [...this.cards];
  }

  public getDeckList(): string[] {
    const set = new Set<string>();
    for (const c of this.cards) {
      set.add(this.normalizeDeckPath(c.deckPath));
    }
    if (set.size === 0) set.add('Inbox');
    return Array.from(set);
  }

  public getCardsByDeck(deckPath?: string, recursive: boolean = true): AnkiCard[] {
    if (!deckPath || deckPath === 'ALL') return [...this.cards];
    const target = this.normalizeDeckPath(deckPath);
    if (!recursive) {
      return this.cards.filter((c) => this.normalizeDeckPath(c.deckPath) === target);
    }
    return this.cards.filter((c) => {
      const p = this.normalizeDeckPath(c.deckPath);
      return p === target || p.startsWith(target + '/');
    });
  }

  public getDueCards(deckPath?: string, recursive: boolean = true): AnkiCard[] {
    return this.getStudyCards(deckPath, 'due', recursive);
  }

  /**
   * Flexible Study Modes (Anki Custom Study / Filtered Decks / Cram)
   */
  public getStudyCards(
    deckPath?: string,
    mode: 'due' | 'cram' | 'difficult' | 'new_only' | 'mastered_review' = 'due',
    recursive: boolean = true
  ): AnkiCard[] {
    const today = new Date().toISOString().split('T')[0];
    const pool = this.getCardsByDeck(deckPath, recursive);

    switch (mode) {
      case 'cram':
        // Study all cards in deck regardless of due date
        return [...pool];
      case 'difficult':
        // Cards with easeFactor < 2.3 or status 'learning' or repetition <= 1
        return pool.filter((c) => c.easeFactor < 2.3 || c.status === 'learning' || c.repetition <= 1);
      case 'new_only':
        // Only brand new unreviewed cards
        return pool.filter((c) => c.status === 'new' || c.repetition === 0);
      case 'mastered_review':
        // Review already mastered cards to keep them fresh
        return pool.filter((c) => c.status === 'mastered');
      case 'due':
      default:
        // Standard SM-2 due cards
        return pool.filter((c) => c.dueDate <= today || c.status === 'new');
    }
  }

  public getStats(deckPath?: string, recursive: boolean = true): DeckStats {
    const today = new Date().toISOString().split('T')[0];
    const pool = this.getCardsByDeck(deckPath, recursive);
    let dueToday = 0;
    let newCards = 0;
    let learning = 0;
    let mastered = 0;

    for (const c of pool) {
      if (c.status === 'mastered') {
        mastered++;
      } else if (c.status === 'new') {
        newCards++;
        dueToday++;
      } else {
        learning++;
        if (c.dueDate <= today) {
          dueToday++;
        }
      }
    }

    return {
      total: pool.length,
      dueToday,
      newCards,
      learning,
      mastered,
    };
  }

  /**
   * Builds a hierarchical tree of all decks with nested cards and counts.
   */
  public getDeckTree(deckFilter?: string): DeckNode[] {
    const today = new Date().toISOString().split('T')[0];
    const rootMap = new Map<string, any>();

    const getOrCreateNode = (parentMap: Map<string, any>, name: string, fullPath: string) => {
      if (!parentMap.has(name)) {
        parentMap.set(name, {
          name,
          fullPath,
          total: 0,
          dueToday: 0,
          newCards: 0,
          mastered: 0,
          cards: [],
          childrenMap: new Map<string, any>(),
        });
      }
      return parentMap.get(name);
    };

    // Make sure at least Inbox or existing decks exist
    const decks = this.getDeckList();
    for (const d of decks) {
      const parts = d.split('/');
      let curMap = rootMap;
      let curPath = '';
      for (const part of parts) {
        curPath = curPath ? `${curPath}/${part}` : part;
        const node = getOrCreateNode(curMap, part, curPath);
        curMap = node.childrenMap;
      }
    }

    // Populate stats and attach direct cards to respective node
    for (const c of this.cards) {
      const deck = this.normalizeDeckPath(c.deckPath);
      const parts = deck.split('/');
      let curMap = rootMap;
      let curPath = '';

      const isDue = c.dueDate <= today || c.status === 'new';
      const isNew = c.status === 'new';
      const isMastered = c.status === 'mastered';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        curPath = curPath ? `${curPath}/${part}` : part;
        const node = getOrCreateNode(curMap, part, curPath);
        node.total += 1;
        if (isDue) node.dueToday += 1;
        if (isNew) node.newCards += 1;
        if (isMastered) node.mastered += 1;

        // If this is the exact deck block for the card, attach the card directly
        if (i === parts.length - 1) {
          node.cards.push(c);
        }

        curMap = node.childrenMap;
      }
    }

    const convertToArray = (nodeMap: Map<string, any>): DeckNode[] => {
      const result: DeckNode[] = [];
      for (const [_, node] of nodeMap) {
        result.push({
          name: node.name,
          fullPath: node.fullPath,
          total: node.total,
          dueToday: node.dueToday,
          newCards: node.newCards,
          mastered: node.mastered,
          cards: node.cards,
          children: convertToArray(node.childrenMap),
        });
      }
      return result;
    };

    let allTrees = convertToArray(rootMap);

    if (deckFilter && deckFilter !== 'ALL') {
      const target = this.normalizeDeckPath(deckFilter);
      const findSubTree = (nodes: DeckNode[]): DeckNode[] => {
        for (const n of nodes) {
          if (n.fullPath === target) return [n];
          const found = findSubTree(n.children);
          if (found.length > 0) return found;
        }
        return [];
      };
      const filtered = findSubTree(allTrees);
      if (filtered.length > 0) return filtered;
    }

    return allTrees;
  }

  public updateCard(cardId: string, updates: Partial<AnkiCard>): AnkiCard | null {
    const card = this.cards.find((c) => c.id === cardId);
    if (!card) return null;

    if (updates.word !== undefined) card.word = updates.word.trim();
    if (updates.translation !== undefined) card.translation = updates.translation.trim();
    if (updates.phonetic !== undefined) card.phonetic = updates.phonetic.trim();
    if (updates.partOfSpeech !== undefined) card.partOfSpeech = updates.partOfSpeech.trim();
    if (updates.definition !== undefined) card.definition = updates.definition.trim();
    if (updates.contextSentence !== undefined) card.contextSentence = updates.contextSentence.trim();
    if (updates.deckPath !== undefined) card.deckPath = this.normalizeDeckPath(updates.deckPath);
    if (updates.status !== undefined) card.status = updates.status;

    this.saveToStorage();
    return card;
  }

  public addCard(cardData: {
    word: string;
    translation: string;
    phonetic?: string;
    partOfSpeech?: string;
    contextSentence?: string;
    definition?: string;
    deckPath?: string;
    sourcePage?: string;
    sourceBlockId?: string;
    tags?: string[];
  }): AnkiCard {
    const deckPath = this.normalizeDeckPath(cardData.deckPath || cardData.sourcePage || 'Inbox');
    const existing = this.cards.find((c) => c.word.toLowerCase() === cardData.word.toLowerCase());

    if (existing) {
      // Update existing card & update deck if provided
      existing.translation = cardData.translation;
      if (cardData.phonetic) existing.phonetic = cardData.phonetic;
      if (cardData.partOfSpeech) existing.partOfSpeech = cardData.partOfSpeech;
      if (cardData.contextSentence) existing.contextSentence = cardData.contextSentence;
      if (cardData.definition) existing.definition = cardData.definition;
      if (cardData.deckPath) existing.deckPath = deckPath;
      if (cardData.sourcePage) existing.sourcePage = cardData.sourcePage;
      if (cardData.sourceBlockId) existing.sourceBlockId = cardData.sourceBlockId;
      if (cardData.tags && cardData.tags.length > 0) existing.tags = cardData.tags;
      this.saveToStorage();
      return existing;
    }

    const today = new Date().toISOString().split('T')[0];
    const newCard: AnkiCard = {
      id: 'anki_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      word: cardData.word,
      translation: cardData.translation,
      phonetic: cardData.phonetic,
      partOfSpeech: cardData.partOfSpeech,
      contextSentence: cardData.contextSentence,
      definition: cardData.definition,
      deckPath,
      sourcePage: cardData.sourcePage,
      sourceBlockId: cardData.sourceBlockId,
      tags: cardData.tags || [],
      repetition: 0,
      interval: 1,
      easeFactor: 2.5,
      dueDate: today,
      createdAt: new Date().toISOString(),
      status: 'new',
    };

    this.cards.unshift(newCard);
    this.saveToStorage();
    return newCard;
  }

  public deleteCard(cardId: string) {
    this.cards = this.cards.filter((c) => c.id !== cardId);
    this.saveToStorage();
  }

  public deleteCards(cardIds: string[]) {
    const set = new Set(cardIds);
    this.cards = this.cards.filter((c) => !set.has(c.id));
    this.saveToStorage();
  }

  public moveCardsToDeck(cardIds: string[], targetDeck: string) {
    const set = new Set(cardIds);
    const norm = this.normalizeDeckPath(targetDeck);
    for (const c of this.cards) {
      if (set.has(c.id)) {
        c.deckPath = norm;
      }
    }
    this.saveToStorage();
  }

  public resetCardsStatus(cardIds: string[]) {
    const set = new Set(cardIds);
    const today = new Date().toISOString().split('T')[0];
    for (const c of this.cards) {
      if (set.has(c.id)) {
        c.status = 'new';
        c.repetition = 0;
        c.interval = 1;
        c.easeFactor = 2.5;
        c.dueDate = today;
      }
    }
    this.saveToStorage();
  }

  public renameDeck(oldPath: string, newPath: string) {
    const oldNorm = this.normalizeDeckPath(oldPath);
    const newNorm = this.normalizeDeckPath(newPath);
    if (!oldNorm || !newNorm || oldNorm === newNorm) return;

    for (const c of this.cards) {
      const cur = this.normalizeDeckPath(c.deckPath);
      if (cur === oldNorm) {
        c.deckPath = newNorm;
      } else if (cur.startsWith(oldNorm + '/')) {
        c.deckPath = newNorm + cur.slice(oldNorm.length);
      }
    }
    this.saveToStorage();
  }

  public deleteDeck(deckPath: string, deleteCards: boolean = false) {
    const target = this.normalizeDeckPath(deckPath);
    if (deleteCards) {
      this.cards = this.cards.filter((c) => {
        const p = this.normalizeDeckPath(c.deckPath);
        return p !== target && !p.startsWith(target + '/');
      });
    } else {
      // Move cards to Inbox
      for (const c of this.cards) {
        const p = this.normalizeDeckPath(c.deckPath);
        if (p === target || p.startsWith(target + '/')) {
          c.deckPath = 'Inbox';
        }
      }
    }
    this.saveToStorage();
  }

  /**
   * SuperMemo 2 (SM-2) Spaced Repetition Logic
   */
  public reviewCard(cardId: string, rating: CardRating): AnkiCard {
    const card = this.cards.find((c) => c.id === cardId);
    if (!card) throw new Error('Card not found');

    let q = 3; // grade rating
    if (rating === 'again') q = 1;
    if (rating === 'hard') q = 2;
    if (rating === 'good') q = 3;
    if (rating === 'easy') q = 5;

    let { repetition, interval, easeFactor } = card;

    if (q >= 3) {
      if (repetition === 0) {
        interval = 1;
      } else if (repetition === 1) {
        interval = 6;
      } else {
        interval = Math.round(interval * easeFactor);
      }
      repetition += 1;
    } else {
      repetition = 0;
      interval = 1;
    }

    // Adjust ease factor EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
    easeFactor = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    if (easeFactor < 1.3) easeFactor = 1.3;

    // Next due date
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + interval);
    const dueDateStr = nextDate.toISOString().split('T')[0];

    card.repetition = repetition;
    card.interval = interval;
    card.easeFactor = Number(easeFactor.toFixed(2));
    card.dueDate = dueDateStr;
    card.lastReviewed = new Date().toISOString();

    if (repetition >= 5) {
      card.status = 'mastered';
    } else {
      card.status = 'learning';
    }

    this.saveToStorage();
    return card;
  }

  /**
   * Exports cards into Logseq Hierarchical Outliner format (#card / #deck)
   */
  public exportToLogseqMarkdown(deckFilter?: string): string {
    const pool = this.getCardsByDeck(deckFilter, true);
    const lines: string[] = [
      'title:: Vocabulary Deck',
      'tags:: [[Anki]], [[Flashcards]]',
      'icon:: 🎴',
      '',
      `# Saved Vocabulary Deck${deckFilter && deckFilter !== 'ALL' ? ` — ${deckFilter}` : ''}`,
    ];

    // Group cards by deckPath
    const grouped = new Map<string, AnkiCard[]>();
    for (const c of pool) {
      const p = this.normalizeDeckPath(c.deckPath);
      if (!grouped.has(p)) grouped.set(p, []);
      grouped.get(p)!.push(c);
    }

    const sortedDecks = Array.from(grouped.keys()).sort();

    for (const d of sortedDecks) {
      const cardsInDeck = grouped.get(d)!;
      const deckParts = d.split('/');
      const indentBase = '  '.repeat(Math.max(0, deckParts.length - 1));
      
      lines.push(`- [[${d}]] #deck`);
      for (const c of cardsInDeck) {
        const phoneticPart = c.phonetic ? ` [${c.phonetic}]` : '';
        const posPart = c.partOfSpeech ? ` (${c.partOfSpeech})` : '';
        const indent = indentBase + '  ';

        lines.push(`${indent}- **${c.word}**${posPart}${phoneticPart} #card`);
        lines.push(`${indent}  translation:: ${c.translation}`);
        lines.push(`${indent}  due-date:: ${c.dueDate}`);
        lines.push(`${indent}  ease-factor:: ${c.easeFactor}`);
        lines.push(`${indent}  interval:: ${c.interval}`);
        if (c.sourcePage) {
          lines.push(`${indent}  source-page:: [[${c.sourcePage}]]`);
        }
        lines.push(`${indent}  - **Definition**: ${c.definition || c.translation}`);
        if (c.contextSentence) {
          lines.push(`${indent}  - **Context**: "${c.contextSentence}"`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Imports or merges cards extracted from Logseq Graph blocks.
   */
  public importFromLogseqBlocks(items: Partial<AnkiCard>[]): { added: number; updated: number; total: number } {
    let added = 0;
    let updated = 0;

    for (const item of items) {
      if (!item.word || !item.word.trim()) continue;
      const cleanWord = item.word.trim();
      const existing = this.cards.find(c => c.word.toLowerCase() === cleanWord.toLowerCase());
      if (existing) {
        if (item.translation) existing.translation = item.translation;
        if (item.phonetic) existing.phonetic = item.phonetic;
        if (item.partOfSpeech) existing.partOfSpeech = item.partOfSpeech;
        if (item.definition) existing.definition = item.definition;
        if (item.contextSentence) existing.contextSentence = item.contextSentence;
        if (item.deckPath) existing.deckPath = this.normalizeDeckPath(item.deckPath);
        if (item.sourcePage) existing.sourcePage = item.sourcePage;
        if (item.dueDate) existing.dueDate = item.dueDate;
        if (typeof item.interval === 'number') existing.interval = item.interval;
        if (typeof item.easeFactor === 'number') existing.easeFactor = item.easeFactor;
        if (typeof item.repetition === 'number') existing.repetition = item.repetition;
        updated++;
      } else {
        this.cards.push({
          id: item.id || `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          word: cleanWord,
          translation: item.translation || cleanWord,
          phonetic: item.phonetic,
          partOfSpeech: item.partOfSpeech,
          definition: item.definition,
          contextSentence: item.contextSentence,
          deckPath: this.normalizeDeckPath(item.deckPath || item.sourcePage || 'Inbox'),
          sourcePage: item.sourcePage,
          dueDate: item.dueDate || new Date().toISOString().split('T')[0],
          interval: typeof item.interval === 'number' ? item.interval : 0,
          easeFactor: typeof item.easeFactor === 'number' ? item.easeFactor : 2.5,
          repetition: typeof item.repetition === 'number' ? item.repetition : 0,
          status: item.status || 'new',
          createdAt: item.createdAt || new Date().toISOString(),
          lastReviewed: item.lastReviewed,
          tags: Array.isArray(item.tags) ? item.tags : [],
        });
        added++;
      }
    }

    this.saveToStorage();
    return { added, updated, total: this.cards.length };
  }

  /**
   * Exports full database to JSON for 100% fidelity backup.
   */
  public exportBackupJSON(): string {
    const payload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      cardCount: this.cards.length,
      cards: this.cards,
    };
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Restores database from JSON backup (supports 'merge' or 'replace').
   */
  public importBackupJSON(jsonStr: string, mode: 'merge' | 'replace' = 'merge'): { added: number; updated: number; total: number } {
    const data = JSON.parse(jsonStr);
    const incomingCards: any[] = Array.isArray(data) ? data : (Array.isArray(data.cards) ? data.cards : []);
    if (!incomingCards.length) {
      throw new Error('Không tìm thấy danh sách thẻ từ vựng hợp lệ trong file backup!');
    }

    let added = 0;
    let updated = 0;

    if (mode === 'replace') {
      this.cards = incomingCards.map((c) => ({
        id: c.id || `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        word: c.word || 'Unknown',
        translation: c.translation || '',
        phonetic: c.phonetic,
        partOfSpeech: c.partOfSpeech,
        definition: c.definition,
        contextSentence: c.contextSentence,
        deckPath: this.normalizeDeckPath(c.deckPath || c.sourcePage || 'Inbox'),
        sourcePage: c.sourcePage,
        dueDate: c.dueDate || new Date().toISOString().split('T')[0],
        interval: typeof c.interval === 'number' ? c.interval : 0,
        easeFactor: typeof c.easeFactor === 'number' ? c.easeFactor : 2.5,
        repetition: typeof c.repetition === 'number' ? c.repetition : 0,
        status: c.status || 'new',
        createdAt: c.createdAt || new Date().toISOString(),
        lastReviewed: c.lastReviewed,
        tags: Array.isArray(c.tags) ? c.tags : [],
      }));
      added = this.cards.length;
    } else {
      // Merge mode
      for (const inc of incomingCards) {
        if (!inc.word) continue;
        const existing = this.cards.find((c) => c.id === inc.id || c.word.toLowerCase() === inc.word.toLowerCase());
        if (existing) {
          existing.translation = inc.translation || existing.translation;
          existing.phonetic = inc.phonetic || existing.phonetic;
          existing.partOfSpeech = inc.partOfSpeech || existing.partOfSpeech;
          existing.definition = inc.definition || existing.definition;
          existing.contextSentence = inc.contextSentence || existing.contextSentence;
          if (inc.deckPath) existing.deckPath = this.normalizeDeckPath(inc.deckPath);
          updated++;
        } else {
          this.cards.push({
            id: inc.id || `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            word: inc.word,
            translation: inc.translation || '',
            phonetic: inc.phonetic,
            partOfSpeech: inc.partOfSpeech,
            definition: inc.definition,
            contextSentence: inc.contextSentence,
            deckPath: this.normalizeDeckPath(inc.deckPath || inc.sourcePage || 'Inbox'),
            sourcePage: inc.sourcePage,
            dueDate: inc.dueDate || new Date().toISOString().split('T')[0],
            interval: typeof inc.interval === 'number' ? inc.interval : 0,
            easeFactor: typeof inc.easeFactor === 'number' ? inc.easeFactor : 2.5,
            repetition: typeof inc.repetition === 'number' ? inc.repetition : 0,
            status: inc.status || 'new',
            createdAt: inc.createdAt || new Date().toISOString(),
            lastReviewed: inc.lastReviewed,
            tags: Array.isArray(inc.tags) ? inc.tags : [],
          });
          added++;
        }
      }
    }

    this.saveToStorage();
    return { added, updated, total: this.cards.length };
  }

  /**
   * Exports cards to standard Anki Desktop tab-separated format (.txt/.tsv).
   * Compatible with Anki Desktop File -> Import.
   * Converts 'A/B/C' deck paths into Anki's native 'A::B::C' nested deck format.
   */
  public exportToAnkiTSV(deckFilter?: string): string {
    const pool = this.getCardsByDeck(deckFilter, true);
    const lines: string[] = [
      '#separator:tab',
      '#html:true',
      '#tags column:4',
      '#deck column:3',
    ];

    for (const c of pool) {
      // 1. Front Field
      let frontHtml = `<b>${this.escapeAnkiField(c.word)}</b>`;
      if (c.partOfSpeech) {
        frontHtml += ` <span style="font-size:0.85em;color:#888;">(${this.escapeAnkiField(c.partOfSpeech)})</span>`;
      }
      if (c.phonetic) {
        frontHtml += ` <span style="font-size:0.85em;color:#6366f1;">[${this.escapeAnkiField(c.phonetic)}]</span>`;
      }
      if (c.contextSentence) {
        frontHtml += `<br><small style="color:#64748b;font-style:italic;">"${this.escapeAnkiField(c.contextSentence)}"</small>`;
      }

      // 2. Back Field
      let backHtml = `<div style="font-size:1.1em;font-weight:bold;color:#059669;">${this.escapeAnkiField(c.translation)}</div>`;
      if (c.definition && c.definition.trim() !== c.translation.trim()) {
        backHtml += `<div style="margin-top:6px;font-size:0.9em;color:#475569;">${this.escapeAnkiField(c.definition)}</div>`;
      }

      // 3. Deck Field (Convert / to :: for native Anki sub-decks)
      const ankiDeck = this.normalizeDeckPath(c.deckPath).replace(/\//g, '::');

      // 4. Tags Field
      const tagList = ['logseq_anki', ...(c.tags || [])];
      const tags = tagList.join(' ');

      lines.push(`${frontHtml}\t${backHtml}\t${ankiDeck}\t${tags}`);
    }

    return lines.join('\n');
  }

  private escapeAnkiField(str?: string): string {
    if (!str) return '';
    return str
      .replace(/\t/g, ' ')
      .replace(/\r?\n/g, '<br>');
  }
}
