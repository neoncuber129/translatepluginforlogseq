import '@logseq/libs';
import JSZip from 'jszip';
import { TranslationService, TranslationEngine } from './services/translator';
import { LogseqMarkdownParser } from './services/markdownParser';
import { GraphScannerService, LogseqFile, ScanProgress } from './services/graphScanner';
import { DictionaryService, DictionaryResult } from './services/dictionary';
import { AnkiStore, CardRating, AnkiCard, DeckNode } from './services/ankiStore';
import { SettingsStore, GraphPair } from './services/settingsStore';
import {
  saveDirectoryHandle,
  getDirectoryHandle,
  removeDirectoryHandle,
  verifyHandlePermission,
} from './services/handleStore';

/* ─── Singleton Services ─── */
let settingsStore: SettingsStore;
let translator: TranslationService;
let parser: LogseqMarkdownParser;
let scanner: GraphScannerService;
let dictionary: DictionaryService;
let ankiStore: AnkiStore;

let sourceFiles: LogseqFile[] = [];
let destinationFiles: LogseqFile[] = [];
let currentDictResult: DictionaryResult | null = null;
let currentReviewCard: AnkiCard | null = null;
let currentSubSelectionText: string = '';
let currentSelectedDeck: string = 'ALL';
let currentActiveSubtab: 'study' | 'list' = 'study';
let currentStudyMode: 'due' | 'cram' | 'difficult' | 'new_only' | 'mastered_review' = 'due';
let selectedCardIds = new Set<string>();
let collapsedDeckPaths = new Set<string>();
let collapsedOutlinerNodes = new Set<string>();
let lastMouseX = 0;
let lastMouseY = 0;

// Track mouse globally (in top window if accessible)
try {
  const topWin = window.top ?? window;
  (topWin.document as Document).addEventListener('mousemove', (e: MouseEvent) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
} catch {}
document.addEventListener('mousemove', (e: MouseEvent) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});

/* ─── Whether running inside Logseq ─── */
const inLogseq = typeof logseq !== 'undefined';

/* ═══════════════════════════════════════
   BOOTSTRAP — called by logseq.ready()
   ═══════════════════════════════════════ */
async function main() {
  settingsStore = new SettingsStore();
  const initialSettings = settingsStore.getSettings();

  translator = new TranslationService({
    engine: initialSettings.engine,
    sourceLang: initialSettings.sourceLang,
    targetLang: initialSettings.targetLang,
    apiKey: initialSettings.apiKey,
    delayMs: 100,
  });

  parser    = new LogseqMarkdownParser(translator);
  ankiStore = new AnkiStore();
  scanner   = new GraphScannerService(translator, parser, ankiStore);
  dictionary = new DictionaryService(translator);

  if (inLogseq) {
    logseq.App.registerUIItem('toolbar', {
      key: 'gta-toolbar-btn',
      template: `
        <a class="button" data-on-click="openUI" title="Graph Translator & Anki Studio">
          <img src="${logseq.baseInfo.lsr}icon.svg" style="width:20px;height:20px;" />
        </a>`,
    });

    logseq.provideModel({
      openUI: () => showFullAppUI(),
    });

    logseq.App.registerCommandPalette(
      { key: 'open-gta', label: '🌐 Graph Translator & Anki Studio' },
      () => showFullAppUI()
    );

    // ——— Global Shortcut Ctrl+Shift+D & Slash Commands ———
    logseq.App.registerCommandShortcut(
      { binding: 'ctrl+shift+d', mode: 'global' },
      async () => {
        try {
          const selText = getTopFrameSelection();
          if (selText) {
            smartLookupAndOpenPopup(selText);
            return;
          }

          const editing = await logseq.Editor.getEditingBlockContent();
          if (editing) {
            const clean = cleanBlockText(editing);
            if (clean) {
              smartLookupAndOpenPopup(clean);
              return;
            }
          }

          logseq.UI.showMsg('🔍 Hãy bôi đen từ cần tra cứu từ điển!', 'warning');
        } catch (err) {
          logseq.UI.showMsg('⚠️ Không lấy được nội dung bôi đen!', 'warning');
        }
      }
    );

    logseq.Editor.registerSlashCommand('🌐 Graph Translator & Anki Studio', async () => showFullAppUI());

    logseq.Editor.registerSlashCommand('🔍 Tra từ điển & Lưu Anki', async (e) => {
      const selText = getTopFrameSelection();
      if (selText) {
        smartLookupAndOpenPopup(selText);
        return;
      }
      const block = await logseq.Editor.getBlock(e.uuid);
      if (block?.content) {
        smartLookupAndOpenPopup(cleanBlockText(block.content));
      }
    });

    logseq.Editor.registerBlockContextMenuItem('🔍 Tra từ & Lưu Anki [Ctrl+Shift+D]', async (e) => {
      const selText = getTopFrameSelection();
      if (selText) {
        smartLookupAndOpenPopup(selText);
        return;
      }
      const block = await logseq.Editor.getBlock(e.uuid);
      if (block?.content) {
        smartLookupAndOpenPopup(cleanBlockText(block.content));
      }
    });

    logseq.provideStyle(`
      #logseq-graph-translator-anki--${logseq.baseInfo.id} {
        position: fixed !important;
        inset: 0 !important;
        z-index: 99999 !important;
      }
      #logseq-graph-translator-anki--${logseq.baseInfo.id} iframe {
        width : 100vw !important;
        height: 100vh !important;
        border: none  !important;
        background: transparent !important;
      }
    `);

    logseq.on('ui:visible:changed', ({ visible }: { visible: boolean }) => {
      if (!visible) {
        document.getElementById('dict-popup-modal')?.classList.add('hidden');
        document.body.classList.remove('popup-only');
      }
    });
  }

  setupDOM();
  initGlobalSelectionListener();
  initOutsideClickListener();
  initHoverWordListener();
  await restoreSavedSettings();
  updateAnkiUI();
}

/* ═══════════════════════════════════════
   SETTINGS PERSISTENCE & RESTORE
   ═══════════════════════════════════════ */
async function restoreSavedSettings() {
  const settings = settingsStore.getSettings();

  const engineSel = document.getElementById('engine-select') as HTMLSelectElement;
  const targetLangSel = document.getElementById('target-lang-select') as HTMLSelectElement;
  const popupTargetLangSel = document.getElementById('popup-target-lang-select') as HTMLSelectElement;
  const apiKeyInp = document.getElementById('api-key-input') as HTMLInputElement;
  const optLinks = document.getElementById('opt-translate-links') as HTMLInputElement;
  const optProps = document.getElementById('opt-translate-props') as HTMLInputElement;
  const optClearCache = document.getElementById('opt-clear-cache') as HTMLInputElement;
  const optHoverTranslate = document.getElementById('opt-hover-translate') as HTMLInputElement;
  const apiKeyCont = document.getElementById('api-key-container');

  if (engineSel) engineSel.value = settings.engine || 'google';
  if (targetLangSel) targetLangSel.value = settings.targetLang || 'vi';
  if (popupTargetLangSel) popupTargetLangSel.value = settings.targetLang || 'vi';
  if (apiKeyInp) apiKeyInp.value = settings.apiKey || '';
  if (optLinks) optLinks.checked = settings.translatePageLinks ?? true;
  if (optProps) optProps.checked = settings.translateProperties ?? false;
  if (optClearCache) optClearCache.checked = settings.clearCache ?? false;
  if (optHoverTranslate) optHoverTranslate.checked = settings.hoverTranslateOnHover ?? true;

  const headerHoverToggle = document.getElementById('toggle-hover-translate-header') as HTMLInputElement;
  if (headerHoverToggle) headerHoverToggle.checked = settings.hoverTranslateOnHover ?? true;

  const headerAutoPopup = document.getElementById('toggle-auto-popup-header') as HTMLInputElement;
  if (headerAutoPopup) headerAutoPopup.checked = settings.autoPopupOnSelect ?? true;

  const popupToggleBtn = document.getElementById('popup-toggle-auto-btn');
  if (popupToggleBtn) {
    const isAuto = settings.autoPopupOnSelect ?? true;
    popupToggleBtn.textContent = isAuto ? '⚡ Auto: BẬT' : '⚡ Auto: TẮT';
    popupToggleBtn.style.color = isAuto ? 'var(--success)' : 'var(--text-muted)';
    popupToggleBtn.style.borderColor = isAuto ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.15)';
    popupToggleBtn.style.background = isAuto ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.05)';
  }

  const needsKey = ['openai', 'deepl', 'libretranslate'].includes(settings.engine);
  apiKeyCont?.classList.toggle('hidden', !needsKey);

  if (settings.lastSourcePath) {
    const el = document.getElementById('source-folder-path');
    if (el) el.textContent = settings.lastSourcePath;
    try {
      const files = await readSourceGraphFromPath(settings.lastSourcePath);
      if (files.length > 0) {
        sourceFiles = files;
        updateSourceFilesState();
      }
    } catch (e) {}
  }
}

/* ═══════════════════════════════════════
   DOM SETUP
   ═══════════════════════════════════════ */
function setupDOM() {
  // Tab switcher
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (!tab) return;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(tab)?.classList.add('active');
    });
  });

  // Close buttons + Escape + Outside Backdrop Click
  document.getElementById('close-plugin-btn')?.addEventListener('click', closePluginUI);
  document.getElementById('close-dict-popup-btn')?.addEventListener('click', closePluginUI);
  document.getElementById('dict-popup-modal')?.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement;
    if (target && !target.closest('.popup-card')) {
      closePluginUI();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePluginUI();
  });

  // ── Source Selection: Use Active Graph button ──
  document.getElementById('use-active-graph-btn')?.addEventListener('click', async () => {
    if (!inLogseq) {
      alert('Chức năng này chỉ hoạt động trong ứng dụng Logseq.');
      return;
    }
    appendLog('info', '⏳ Đang quét toàn bộ Graph đang mở trong Logseq (pages, journals, assets)...');
    const currGraph = await logseq.App.getCurrentGraph();
    if (!currGraph) {
      appendLog('error', 'Không tìm thấy Graph đang mở trong Logseq!');
      return;
    }
    sourceFiles = await readLogseqActiveGraph();
    updateSourceFilesState();

    const pathStr = `📌 Active Graph: ${currGraph.name} (${sourceFiles.length} file)`;
    const display = document.getElementById('source-folder-path');
    if (display) display.textContent = pathStr;
    settingsStore.updateSettings({ lastSourcePath: pathStr });
    appendLog('success', `✅ Đã quét nạp thành công ${sourceFiles.length} file từ Graph "${currGraph.name}".`);
  });

  // ── Source Selection: Browse folder ──
  const sourceInput = document.getElementById('source-file-input') as HTMLInputElement;
  document.getElementById('select-source-folder-btn')?.addEventListener('click', async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const h = await (window as any).showDirectoryPicker();
        sourceFiles = await readDirHandle(h);
        updateSourceFilesState();
        const pathStr = `📁 ${h.name} (${sourceFiles.length} file)`;
        const el = document.getElementById('source-folder-path');
        if (el) el.textContent = pathStr;
        settingsStore.updateSettings({ lastSourcePath: pathStr });
        appendLog('success', `✅ Đã nạp ${sourceFiles.length} file (pages, journals, assets) từ thư mục "${h.name}".`);
        return;
      } catch (err: any) {
        if (err.name !== 'AbortError') sourceInput.click();
        return;
      }
    }
    sourceInput.click();
  });

  sourceInput?.addEventListener('change', async (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (!files?.length) return;
    sourceFiles = await readFileList(files);
    updateSourceFilesState();
    const root = files[0].webkitRelativePath.split('/')[0] || 'Folder';
    const pathStr = `📁 ${root} (${sourceFiles.length} file)`;
    const el = document.getElementById('source-folder-path');
    if (el) el.textContent = pathStr;
    settingsStore.updateSettings({ lastSourcePath: pathStr });
    appendLog('success', `✅ Đã nạp ${sourceFiles.length} file từ thư mục đã chọn.`);
  });

  // ── Source Selection: Custom Path Input ──
  const sourcePathInputRow = document.getElementById('source-path-input-row');
  const sourcePathCustomInput = document.getElementById('source-path-custom-input') as HTMLInputElement;
  const confirmSourcePathBtn = document.getElementById('confirm-source-path-btn');

  document.getElementById('input-source-path-btn')?.addEventListener('click', () => {
    sourcePathInputRow?.classList.toggle('hidden');
    if (sourcePathCustomInput && !sourcePathInputRow?.classList.contains('hidden')) {
      sourcePathCustomInput.focus();
    }
  });

  confirmSourcePathBtn?.addEventListener('click', async () => {
    const p = sourcePathCustomInput?.value?.trim().replace(/^["']|["']$/g, '').trim();
    if (!p) {
      alert('Vui lòng nhập đường dẫn thư mục Graph nguồn!');
      return;
    }

    appendLog('info', `⏳ Đang đọc các file trong đường dẫn: "${p}"...`);
    const files = await readSourceGraphFromPath(p);
    if (files.length > 0) {
      sourceFiles = files;
      updateSourceFilesState();
      const pathStr = `📌 Path: ${p} (${sourceFiles.length} file)`;
      const el = document.getElementById('source-folder-path');
      if (el) el.textContent = pathStr;
      settingsStore.updateSettings({ lastSourcePath: pathStr });
      appendLog('success', `✅ Đã nạp thành công ${sourceFiles.length} file từ đường dẫn.`);
      sourcePathInputRow?.classList.add('hidden');
    } else {
      appendLog('warn', `⚠️ Không tìm thấy file markdown (.md/.org) hoặc assets nào tại: "${p}".`);
      alert(`Không tìm thấy file nào trong thư mục "${p}". Vui lòng kiểm tra lại đường dẫn!`);
    }
  });

  // ── Translation config events ──
  const engineSel = document.getElementById('engine-select') as HTMLSelectElement;
  const apiKeyCont = document.getElementById('api-key-container');
  const apiKeyInp = document.getElementById('api-key-input') as HTMLInputElement;
  const optLinks = document.getElementById('opt-translate-links') as HTMLInputElement;
  const optProps = document.getElementById('opt-translate-props') as HTMLInputElement;
  const optClearCache = document.getElementById('opt-clear-cache') as HTMLInputElement;

  engineSel?.addEventListener('change', () => {
    const engine = engineSel.value as TranslationEngine;
    const needsKey = ['openai', 'deepl', 'libretranslate'].includes(engine);
    apiKeyCont?.classList.toggle('hidden', !needsKey);
    translator.updateOptions({ engine });
    settingsStore.updateSettings({ engine });
  });

  const targetLangSelect = document.getElementById('target-lang-select') as HTMLSelectElement;
  const popupTargetLangSelect = document.getElementById('popup-target-lang-select') as HTMLSelectElement;

  targetLangSelect?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    translator.updateOptions({ targetLang: val });
    settingsStore.updateSettings({ targetLang: val });
    if (popupTargetLangSelect) popupTargetLangSelect.value = val;
  });

  popupTargetLangSelect?.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    translator.updateOptions({ targetLang: val });
    settingsStore.updateSettings({ targetLang: val });
    if (targetLangSelect) targetLangSelect.value = val;
    if (currentDictResult) {
      openDictionaryPopup(currentDictResult.word, false, currentDictResult.contextSentence);
    }
  });

  apiKeyInp?.addEventListener('input', () => {
    translator.updateOptions({ apiKey: apiKeyInp.value });
    settingsStore.updateSettings({ apiKey: apiKeyInp.value });
  });

  optLinks?.addEventListener('change', () => {
    settingsStore.updateSettings({ translatePageLinks: optLinks.checked });
  });

  optProps?.addEventListener('change', () => {
    settingsStore.updateSettings({ translateProperties: optProps.checked });
  });

  optClearCache?.addEventListener('change', () => {
    settingsStore.updateSettings({ clearCache: optClearCache.checked });
  });

  const optHoverTranslate = document.getElementById('opt-hover-translate') as HTMLInputElement;
  const headerHoverToggle = document.getElementById('toggle-hover-translate-header') as HTMLInputElement;

  const updateHoverToggleState = (val: boolean) => {
    settingsStore.updateSettings({ hoverTranslateOnHover: val });
    if (optHoverTranslate) optHoverTranslate.checked = val;
    if (headerHoverToggle) headerHoverToggle.checked = val;
    if (!val) hideHoverWordTooltip();
    if (inLogseq) {
      logseq.UI.showMsg(val ? '✨ Đã BẬT chức năng rê chuột (hover) xem nghĩa từ!' : '⏸️ Đã TẮT chức năng rê chuột xem nghĩa.', 'info');
    }
  };

  optHoverTranslate?.addEventListener('change', () => {
    updateHoverToggleState(optHoverTranslate.checked);
  });

  headerHoverToggle?.addEventListener('change', () => {
    updateHoverToggleState(headerHoverToggle.checked);
  });

  // ── Auto-popup on selection toggle handlers ──
  const toggleAutoPopup = (newVal: boolean) => {
    settingsStore.updateSettings({ autoPopupOnSelect: newVal });
    const headerCb = document.getElementById('toggle-auto-popup-header') as HTMLInputElement;
    if (headerCb) headerCb.checked = newVal;

    const popupBtn = document.getElementById('popup-toggle-auto-btn');
    if (popupBtn) {
      popupBtn.textContent = newVal ? '⚡ Auto: BẬT' : '⚡ Auto: TẮT';
      popupBtn.style.color = newVal ? 'var(--success)' : 'var(--text-muted)';
      popupBtn.style.borderColor = newVal ? 'rgba(16,185,129,0.3)' : 'rgba(255,255,255,0.15)';
      popupBtn.style.background = newVal ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.05)';
    }

    if (inLogseq) {
      logseq.UI.showMsg(newVal ? '⚡ Đã BẬT tự động hiện popup khi bôi đen từ!' : '⏸️ Đã TẮT tự động hiện popup (Dùng Ctrl+Shift+D khi cần).', 'info');
    }
  };

  document.getElementById('toggle-auto-popup-header')?.addEventListener('change', (e) => {
    toggleAutoPopup((e.target as HTMLInputElement).checked);
  });

  document.getElementById('popup-toggle-auto-btn')?.addEventListener('click', () => {
    const currentVal = settingsStore.getSettings().autoPopupOnSelect ?? true;
    toggleAutoPopup(!currentVal);
  });

  document.getElementById('clear-cache-now-btn')?.addEventListener('click', () => {
    translator.clearCache();
    appendLog('info', '🧹 Đã xóa toàn bộ bộ nhớ dịch thuật (Translation Memory Cache).');
    alert('🧹 Đã xóa toàn bộ Cache dịch thuật thành công!');
  });

  // ── File Selection Checklist Modal ──
  const filePreviewBtn = document.getElementById('open-file-preview-btn');
  const fileModal = document.getElementById('file-modal');
  const closeFileModalBtn = document.getElementById('close-file-modal-btn');
  const confirmFileSelectionBtn = document.getElementById('confirm-file-selection-btn');
  const toggleSelectAllBtn = document.getElementById('toggle-select-all-btn');
  const fileSearchInput = document.getElementById('file-search-input') as HTMLInputElement;

  filePreviewBtn?.addEventListener('click', () => {
    renderFileChecklistModal();
    fileModal?.classList.remove('hidden');
  });

  closeFileModalBtn?.addEventListener('click', () => fileModal?.classList.add('hidden'));
  confirmFileSelectionBtn?.addEventListener('click', () => {
    fileModal?.classList.add('hidden');
    updateSourceFilesState();
  });

  toggleSelectAllBtn?.addEventListener('click', () => {
    const allSelected = sourceFiles.every((f) => f.selected !== false);
    sourceFiles.forEach((f) => (f.selected = !allSelected));
    renderFileChecklistModal();
  });

  fileSearchInput?.addEventListener('input', () => {
    renderFileChecklistModal(fileSearchInput.value.toLowerCase().trim());
  });

  // ── Translation execution: Translate, Check Language & Export ZIP ──
  const startBtn = document.getElementById('start-translation-btn') as HTMLButtonElement;
  const pauseBtn = document.getElementById('pause-translation-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-translation-btn') as HTMLButtonElement;

  startBtn?.addEventListener('click', async () => {
    // 1. Clear page mappings and cache for 100% fresh translation into target language
    parser.clearPageMapping();
    translator.clearCache();
    appendLog('info', '🧹 Đã xóa bộ đệm cũ, bắt đầu quá trình dịch mới 100% sang ngôn ngữ đích...');

    // 2. Sync options directly from DOM elements
    const targetLangSel = document.getElementById('target-lang-select') as HTMLSelectElement;
    const engineSel = document.getElementById('engine-select') as HTMLSelectElement;
    const apiKeyInp = document.getElementById('api-key-input') as HTMLInputElement;

    const targetLang = targetLangSel?.value || 'vi';
    const engine = (engineSel?.value as TranslationEngine) || 'google';
    const apiKey = apiKeyInp?.value || '';

    translator.updateOptions({ targetLang, engine, apiKey });
    settingsStore.updateSettings({ targetLang, engine, apiKey });
    appendLog('info', `🎯 Cấu hình dịch: [${engine.toUpperCase()}] Dịch sang ngôn ngữ "${targetLang.toUpperCase()}"`);

    // 3. Refresh source files if needed
    const currentSettings = settingsStore.getSettings();
    const srcPath = currentSettings.lastSourcePath || '📌 Active Graph';
    if (sourceFiles.length === 0) {
      const freshFiles = await readSourceGraphFromPath(srcPath);
      if (freshFiles.length > 0) {
        sourceFiles = freshFiles;
        updateSourceFilesState();
      }
    }

    const activeSelected = sourceFiles.filter((f) => f.selected !== false);
    if (!sourceFiles.length || !activeSelected.length) {
      alert('Vui lòng chọn Graph nguồn và chọn ít nhất 1 file cần dịch!');
      return;
    }

    startBtn.disabled = true;
    pauseBtn.disabled = false;
    cancelBtn.disabled = false;

    const opts = {
      translatePageLinks: optLinks?.checked ?? true,
      translateProperties: optProps?.checked ?? false,
    };

    try {
      destinationFiles = await scanner.translateGraphFiles(
        sourceFiles,
        opts,
        updateProgressUI,
        (l) => appendLog(l.level, l.text),
        targetLang
      );
    } catch (err: any) {
      appendLog('error', `❌ Lỗi trong quá trình dịch: ${err.message}`);
    } finally {
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      cancelBtn.disabled = true;
    }

    if (destinationFiles.length) {
      document.getElementById('export-container')?.classList.remove('hidden');
      const syncStatus = document.getElementById('dest-sync-status-msg');
      const summaryEl = document.getElementById('verification-summary-text');
      const verifyRes = scanner.lastVerificationResult;

      if (verifyRes) {
        if (summaryEl) {
          summaryEl.textContent = verifyRes.summary;
        }
        if (syncStatus) {
          if (verifyRes.passed) {
            syncStatus.innerHTML = `<span style="color:#10b981;font-weight:700;">✅ ĐÃ KIỂM TRA NGÔN NGỮ ĐẠT CHUẨN (${verifyRes.detectedLang.toUpperCase()}) &amp; ĐÓNG GÓI .ZIP THÀNH CÔNG!</span>`;
          } else {
            syncStatus.innerHTML = `<span style="color:#f59e0b;font-weight:700;">⚠️ CẢNH BÁO KIỂM TRA NGÔN NGỮ (Độ khớp: ${verifyRes.confidence}%). File .zip đã sẵn sàng!</span>`;
          }
        }
      }

      // Automatically trigger ZIP download
      await triggerZipDownload(destinationFiles, targetLang);
    }
  });

  pauseBtn?.addEventListener('click', () => {
    const pausing = pauseBtn.textContent?.includes('Dừng');
    if (pausing) {
      scanner.pause();
      pauseBtn.textContent = '▶️ Tiếp Tục';
    } else {
      scanner.resume();
      pauseBtn.textContent = '⏸️ Dừng';
    }
  });

  cancelBtn?.addEventListener('click', () => scanner.cancel());

  document.getElementById('clear-logs-btn')?.addEventListener('click', () => {
    const t = document.getElementById('log-terminal');
    if (t) t.innerHTML = '';
  });

  // ── Manual Export ZIP button ──
  document.getElementById('save-dest-zip-btn')?.addEventListener('click', async () => {
    if (!destinationFiles.length) {
      alert('Chưa có file nào được dịch để xuất gói .zip!');
      return;
    }
    const currentSettings = settingsStore.getSettings();
    await triggerZipDownload(destinationFiles, currentSettings.targetLang || 'vi');
  });

  setupDictionaryAndAnkiListeners();
}

async function triggerZipDownload(files: LogseqFile[], targetLang: string = 'vi') {
  if (!files || files.length === 0) return;
  appendLog('info', `📦 Đang khởi tạo và nén toàn bộ Graph (${files.length} file) thành gói .zip...`);

  try {
    const zip = new JSZip();
    let pageCount = 0;
    let journalCount = 0;
    let assetCount = 0;
    let configCount = 0;

    for (const f of files) {
      if (f.type === 'page') pageCount++;
      else if (f.type === 'journal') journalCount++;
      else if (f.type === 'asset') assetCount++;
      else if (f.type === 'config') configCount++;

      if (f.type === 'asset' || f.content instanceof Uint8Array) {
        zip.file(f.path, f.content, { binary: true });
      } else {
        zip.file(f.path, typeof f.content === 'string' ? f.content : new TextDecoder().decode(f.content));
      }
    }

    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timeStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `Logseq_Translated_${targetLang.toUpperCase()}_${timeStr}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    appendLog(
      'success',
      `📥 [Tải Về Thành Công] Đã xuất file "${a.download}" (${files.length} file: ${pageCount} pages, ${journalCount} journals, ${assetCount} assets, ${configCount} config). Giải nén ra thư mục để mở trực tiếp trong Logseq!`
    );
    if (inLogseq) {
      try {
        logseq.UI.showMsg(`🎉 Đã tải về file .zip (${files.length} file đã dịch)!`, 'success');
      } catch {}
    }
  } catch (err: any) {
    appendLog('error', `❌ Lỗi khi tạo file zip: ${err.message}. Vui lòng bấm nút "💾 Tải Gói .zip" để thử lại.`);
  }
}

function setupDictionaryAndAnkiListeners() {

  // ── Dictionary search in Tab 2 ──
  const dictInput = document.getElementById('dict-search-input') as HTMLInputElement;
  document.getElementById('dict-search-btn')?.addEventListener('click', () => {
    if (dictInput.value.trim()) openDictionaryPopup(dictInput.value.trim());
  });
  dictInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && dictInput.value.trim()) openDictionaryPopup(dictInput.value.trim());
  });

  // ── Add to Anki from tab 2 card ──
  document.getElementById('add-to-anki-btn')?.addEventListener('click', () => {
    if (!currentDictResult) return;
    ankiStore.addCard({
      word: currentDictResult.word, translation: currentDictResult.translation,
      phonetic: currentDictResult.phonetic, partOfSpeech: currentDictResult.partOfSpeech,
      contextSentence: currentDictResult.contextSentence,
      definition: currentDictResult.definitions?.[0]?.definition,
      deckPath: currentSelectedDeck !== 'ALL' ? currentSelectedDeck : 'Inbox',
    });
    updateAnkiUI();
    showToast(`✅ Đã lưu từ "${currentDictResult.word}" vào Anki!`);
  });

  // ── Add to Anki from quick popup (uses user-edited translation & custom/detected deck) ──
  document.getElementById('popup-add-anki-btn')?.addEventListener('click', () => {
    if (!currentDictResult) return;
    const editedTranslation = (document.getElementById('popup-translation-input') as HTMLTextAreaElement)?.value.trim() || currentDictResult.translation;
    const deckVal = (document.getElementById('popup-deck-input') as HTMLInputElement)?.value.trim() || 'Inbox';
    ankiStore.addCard({
      word: currentDictResult.word,
      translation: editedTranslation,
      phonetic: currentDictResult.phonetic,
      partOfSpeech: currentDictResult.partOfSpeech,
      contextSentence: currentDictResult.contextSentence,
      definition: currentDictResult.definitions?.[0]?.definition,
      deckPath: deckVal,
      sourcePage: deckVal,
    });
    updateAnkiUI();
    showToast(`⭐ Đã lưu từ "${currentDictResult.word}" vào Deck [${deckVal}]!`);
  });

  // ── Auto-resize translation textarea as user types ──
  const transTextarea = document.getElementById('popup-translation-input') as HTMLTextAreaElement;
  transTextarea?.addEventListener('input', () => autoResizeTextarea(transTextarea));

  // ── Audio pronunciation in quick popup (Google TTS Endpoint) ──
  document.getElementById('popup-audio-btn')?.addEventListener('click', () => {
    if (!currentDictResult) return;
    playGoogleTTS(currentDictResult.word);
  });

  // ── Sub-selection inside quick popup word header (select sub-phrase to lookup) ──
  const popupWordEl = document.getElementById('popup-word');

  const clearPopupWordHighlight = () => {
    if (currentPopupSession?.wholeText && popupWordEl && popupWordEl.querySelector('mark')) {
      popupWordEl.textContent = currentPopupSession.wholeText;
    }
  };

  popupWordEl?.addEventListener('mousedown', clearPopupWordHighlight);
  popupWordEl?.addEventListener('selectstart', clearPopupWordHighlight);

  popupWordEl?.addEventListener('mouseup', () => {
    const sel = window.getSelection()?.toString().trim();
    if (sel && sel.length >= 2 && currentPopupSession?.wholeText && sel !== currentPopupSession.activeSubWord) {
      if (sel === currentPopupSession.wholeText) {
        restoreWholeLineTranslation();
      } else {
        openDictionaryPopup(sel, true, currentPopupSession.wholeText);
      }
    }
  });

  // ── Restore whole line translation button ──
  document.getElementById('popup-whole-line-btn')?.addEventListener('click', () => {
    restoreWholeLineTranslation();
  });

  // ── Sub-tabs in Anki: Study vs Card List ──
  document.getElementById('tab-sub-study-btn')?.addEventListener('click', () => {
    currentActiveSubtab = 'study';
    document.getElementById('tab-sub-study-btn')?.classList.add('btn-primary', 'active-subtab');
    document.getElementById('tab-sub-study-btn')?.classList.remove('btn-secondary');
    document.getElementById('tab-sub-list-btn')?.classList.add('btn-secondary');
    document.getElementById('tab-sub-list-btn')?.classList.remove('btn-primary', 'active-subtab');
    document.getElementById('subview-study')?.classList.remove('hidden');
    document.getElementById('subview-list')?.classList.add('hidden');
  });

  document.getElementById('tab-sub-list-btn')?.addEventListener('click', () => {
    currentActiveSubtab = 'list';
    document.getElementById('tab-sub-list-btn')?.classList.add('btn-primary', 'active-subtab');
    document.getElementById('tab-sub-list-btn')?.classList.remove('btn-secondary');
    document.getElementById('tab-sub-study-btn')?.classList.add('btn-secondary');
    document.getElementById('tab-sub-study-btn')?.classList.remove('btn-primary', 'active-subtab');
    document.getElementById('subview-list')?.classList.remove('hidden');
    document.getElementById('subview-study')?.classList.add('hidden');
  });

  // ── Create New Deck Button ──
  document.getElementById('create-new-deck-btn')?.addEventListener('click', () => {
    const name = prompt('Nhập tên Deck phân cấp mới (VD: Y Học/Tim Mạch hoặc English/IELTS):');
    if (name && name.trim()) {
      currentSelectedDeck = name.trim();
      updateAnkiUI();
      showToast(`📁 Đã chuyển sang Deck: "${currentSelectedDeck}"`);
    }
  });

  // ── Select All Decks root button ──
  document.getElementById('deck-node-all')?.addEventListener('click', () => {
    currentSelectedDeck = 'ALL';
    updateAnkiUI();
  });

  // ── Study Mode Selector (Due, Cram, Difficult, New, Mastered) ──
  const studyModeSel = document.getElementById('anki-study-mode-select') as HTMLSelectElement;
  studyModeSel?.addEventListener('change', () => {
    currentStudyMode = (studyModeSel.value as any) || 'due';
    updateAnkiUI();
  });

  // ── Empty State Study Action Buttons ──
  document.getElementById('empty-cram-btn')?.addEventListener('click', () => {
    currentStudyMode = 'cram';
    if (studyModeSel) studyModeSel.value = 'cram';
    updateAnkiUI();
  });

  document.getElementById('empty-difficult-btn')?.addEventListener('click', () => {
    currentStudyMode = 'difficult';
    if (studyModeSel) studyModeSel.value = 'difficult';
    updateAnkiUI();
  });

  // ── Search, status filter & Sort in Card List ──
  const triggerListRerender = () => renderCardList();
  document.getElementById('card-search-input')?.addEventListener('input', triggerListRerender);
  document.getElementById('anki-search-input')?.addEventListener('input', triggerListRerender);
  document.getElementById('card-status-filter')?.addEventListener('change', triggerListRerender);
  document.getElementById('anki-status-filter')?.addEventListener('change', triggerListRerender);
  document.getElementById('anki-sort-select')?.addEventListener('change', triggerListRerender);

  // ── Batch Action Toolbar Handlers ──
  document.getElementById('select-all-cards-cb')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    const cards = ankiStore.getCardsByDeck(currentSelectedDeck, true);
    if (checked) {
      cards.forEach(c => selectedCardIds.add(c.id));
    } else {
      selectedCardIds.clear();
    }
    renderCardList();
  });

  document.getElementById('batch-delete-btn')?.addEventListener('click', () => {
    if (selectedCardIds.size === 0) return;
    if (confirm(`Bạn có chắc muốn xóa vĩnh viễn ${selectedCardIds.size} từ vựng đã chọn?`)) {
      ankiStore.deleteCards(Array.from(selectedCardIds));
      selectedCardIds.clear();
      updateAnkiUI();
      showToast('🗑️ Đã xóa các từ vựng đã chọn thành công!');
    }
  });

  document.getElementById('batch-move-btn')?.addEventListener('click', () => {
    if (selectedCardIds.size === 0) return;
    const targetDeck = prompt(`Chuyển ${selectedCardIds.size} từ đã chọn sang Deck (VD: Y Học/Dược Lý hoặc Inbox):`, currentSelectedDeck !== 'ALL' ? currentSelectedDeck : 'Inbox');
    if (targetDeck && targetDeck.trim()) {
      ankiStore.moveCardsToDeck(Array.from(selectedCardIds), targetDeck.trim());
      selectedCardIds.clear();
      updateAnkiUI();
      showToast(`📂 Đã chuyển các từ sang Deck [${targetDeck.trim()}]!`);
    }
  });

  document.getElementById('batch-reset-btn')?.addEventListener('click', () => {
    if (selectedCardIds.size === 0) return;
    if (confirm(`Đặt lại lịch ôn tập cho ${selectedCardIds.size} từ đã chọn về trạng thái Mới (New)?`)) {
      ankiStore.resetCardsStatus(Array.from(selectedCardIds));
      selectedCardIds.clear();
      updateAnkiUI();
      showToast('🔄 Đã đặt lại lịch ôn tập cho các từ đã chọn!');
    }
  });

  // ── Edit Card Modal Handlers ──
  document.getElementById('close-edit-card-btn')?.addEventListener('click', closeEditCardModal);
  document.getElementById('cancel-edit-card-btn')?.addEventListener('click', closeEditCardModal);
  document.getElementById('save-edit-card-btn')?.addEventListener('click', () => {
    const cardId = (document.getElementById('edit-card-id') as HTMLInputElement)?.value;
    if (!cardId) return;

    const word = (document.getElementById('edit-card-word') as HTMLInputElement)?.value;
    const pos = (document.getElementById('edit-card-pos') as HTMLInputElement)?.value;
    const phonetic = (document.getElementById('edit-card-phonetic') as HTMLInputElement)?.value;
    const translation = (document.getElementById('edit-card-translation') as HTMLTextAreaElement)?.value;
    const definition = (document.getElementById('edit-card-definition') as HTMLTextAreaElement)?.value;
    const context = (document.getElementById('edit-card-context') as HTMLTextAreaElement)?.value;
    const deck = (document.getElementById('edit-card-deck') as HTMLInputElement)?.value;
    const status = (document.getElementById('edit-card-status') as HTMLSelectElement)?.value as any;

    if (!word || !translation) {
      alert('Từ vựng và Nghĩa dịch không được để trống!');
      return;
    }

    ankiStore.updateCard(cardId, {
      word,
      partOfSpeech: pos,
      phonetic,
      translation,
      definition,
      contextSentence: context,
      deckPath: deck,
      status,
    });

    closeEditCardModal();
    updateAnkiUI();
    showToast(`💾 Đã cập nhật thành công từ "${word}"!`);
  });

  // ── Pronunciation in Flashcard Player ──
  document.getElementById('anki-audio-btn')?.addEventListener('click', () => {
    if (!currentReviewCard) return;
    playGoogleTTS(currentReviewCard.word);
  });

  // ── Anki review SM-2 Click Listeners ──
  document.getElementById('show-answer-btn')?.addEventListener('click', () => {
    document.getElementById('flashcard-back')?.classList.remove('hidden');
    document.getElementById('show-answer-btn')?.classList.add('hidden');
    document.getElementById('sm2-ratings-row')?.classList.remove('hidden');
  });
  document.querySelectorAll('.btn-rating').forEach(btn => {
    btn.addEventListener('click', () => {
      const rating = btn.getAttribute('data-rating') as CardRating;
      if (currentReviewCard && rating) {
        ankiStore.reviewCard(currentReviewCard.id, rating);
        updateAnkiUI();
      }
    });
  });

  // ── Unified Global Keyboard Shortcuts (Hover Tooltip, Dictionary Popup, Flashcard Review) ──
  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    // 1. If Hover Tooltip is currently visible
    if (currentHoveredTooltipInfo) {
      const info = currentHoveredTooltipInfo;
      if (e.key === 'r' || e.key === 'R' || e.key === '5') {
        e.preventDefault();
        playGoogleTTS(info.word);
        return;
      }
      if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        saveHoverWordToAnki(info);
        return;
      }
      if (e.key === 'd' || e.key === 'D' || e.key === 'Enter') {
        e.preventDefault();
        hideHoverWordTooltip();
        smartLookupAndOpenPopup(info.word);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideHoverWordTooltip();
        return;
      }
    }

    // 2. If Quick Dictionary Popup is currently open
    const dictModal = document.getElementById('dict-popup-modal');
    const isDictPopupOpen = dictModal && !dictModal.classList.contains('hidden');
    if (isDictPopupOpen) {
      if ((e.ctrlKey || e.metaKey || e.altKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        document.getElementById('popup-add-anki-btn')?.click();
        return;
      }
      if ((e.altKey && (e.key === 'r' || e.key === 'R')) || ((e.key === 'r' || e.key === 'R') && (e.target as HTMLElement)?.tagName !== 'TEXTAREA' && (e.target as HTMLElement)?.tagName !== 'INPUT')) {
        e.preventDefault();
        document.getElementById('popup-audio-btn')?.click();
        return;
      }
      if ((e.ctrlKey || e.altKey) && (e.key === 'z' || e.key === 'w')) {
        e.preventDefault();
        document.getElementById('popup-whole-line-btn')?.click();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePluginUI();
        return;
      }
    }

    // 3. If in Anki Tab and in Study subview (Flashcard Player)
    const ankiTab = document.getElementById('anki-tab');
    if (ankiTab && ankiTab.classList.contains('active') && currentActiveSubtab === 'study') {
      const targetTag = (e.target as HTMLElement)?.tagName;
      if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (!currentReviewCard) return;

      const backEl = document.getElementById('flashcard-back');
      const isBackVisible = backEl && !backEl.classList.contains('hidden');

      if (e.key === 'r' || e.key === 'R' || e.key === '5') {
        e.preventDefault();
        playGoogleTTS(currentReviewCard.word);
        return;
      }

      if (!isBackVisible) {
        if (e.code === 'Space' || e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('show-answer-btn')?.click();
        }
      } else {
        if (e.key === '1') {
          e.preventDefault();
          ankiStore.reviewCard(currentReviewCard.id, 'again');
          updateAnkiUI();
        } else if (e.key === '2') {
          e.preventDefault();
          ankiStore.reviewCard(currentReviewCard.id, 'hard');
          updateAnkiUI();
        } else if (e.key === '3' || e.code === 'Space' || e.key === 'Enter') {
          e.preventDefault();
          ankiStore.reviewCard(currentReviewCard.id, 'good');
          updateAnkiUI();
        } else if (e.key === '4') {
          e.preventDefault();
          ankiStore.reviewCard(currentReviewCard.id, 'easy');
          updateAnkiUI();
        }
      }
    }
  };

  try {
    document.addEventListener('keydown', handleGlobalKeyDown);
    if (window.top && window.top !== window && window.top.document) {
      window.top.document.addEventListener('keydown', handleGlobalKeyDown);
    }
    if (window.parent && window.parent !== window && window.parent !== window.top && window.parent.document) {
      window.parent.document.addEventListener('keydown', handleGlobalKeyDown);
    }
  } catch (err) {
    console.warn('handleGlobalKeyDown registration failed:', err);
  }

  // ── Sync to Logseq graph ──
  document.getElementById('sync-anki-to-graph-btn')?.addEventListener('click', async () => {
    const md = ankiStore.exportToLogseqMarkdown(currentSelectedDeck);
    if (inLogseq) {
      try {
        await logseq.Editor.createPage('Vocabulary Deck', {}, { redirect: true });
        const page = await logseq.Editor.getPage('Vocabulary Deck');
        if (page) {
          const lines = md.split('\n').filter(l => l.trim());
          for (const line of lines.slice(0, 80)) {
            await logseq.Editor.appendBlockInPage('Vocabulary Deck', line.replace(/^[-*]\s*/, ''));
          }
        }
        logseq.UI.showMsg('✅ Đã xuất cấu trúc phân cấp Vocabulary Deck vào Logseq!', 'success');
        return;
      } catch (err) { console.warn(err); }
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'Vocabulary Deck.md'; a.click();
    URL.revokeObjectURL(url);
  });

  // ── Bi-directional Sync: Scan & Import #card from Logseq Graph ──
  document.getElementById('anki-scan-graph-btn')?.addEventListener('click', async () => {
    let importedItems: Partial<AnkiCard>[] = [];

    if (inLogseq) {
      try {
        logseq.UI.showMsg('⏳ Đang quét toàn bộ Graph để tìm các thẻ #card...', 'info');

        const queryRes = await logseq.DB.datascriptQuery(
          `[:find (pull ?b [*]) :where [?b :block/content ?c] [(clojure.string/includes? ?c "#card")]]`
        );

        if (Array.isArray(queryRes)) {
          for (const row of queryRes) {
            const block = Array.isArray(row) ? row[0] : row;
            if (!block || !block.content) continue;

            const rawContent: string = block.content;
            if (!rawContent.includes('#card')) continue;

            let pageName = 'Inbox';
            if (block.page && block.page.id) {
              try {
                const page = await logseq.Editor.getPage(block.page.id);
                if (page && (page.originalName || page.name)) {
                  pageName = page.originalName || page.name;
                }
              } catch {}
            }

            let wordLine = rawContent.replace(/#card\b/g, '').trim();
            const boldMatch = wordLine.match(/\*\*([^*]+)\*\*/);
            const word = boldMatch ? boldMatch[1].trim() : wordLine.replace(/^[-*]\s*/, '').trim();

            if (!word) continue;

            let translation = '';
            let phonetic = '';
            let partOfSpeech = '';
            let definition = '';
            let contextSentence = '';
            let dueDate = new Date().toISOString().split('T')[0];
            let interval = 0;
            let easeFactor = 2.5;
            let repetition = 0;

            const posMatch = wordLine.match(/\(([a-zA-Z]+)\)/);
            if (posMatch) partOfSpeech = posMatch[1];
            const phoMatch = wordLine.match(/\[([^[\]]+)\]/);
            if (phoMatch) phonetic = phoMatch[1];

            if (block.properties) {
              if (block.properties.translation) translation = String(block.properties.translation);
              if (block.properties.dueDate) dueDate = String(block.properties.dueDate);
              if (block.properties.interval) interval = Number(block.properties.interval) || 0;
              if (block.properties.easeFactor) easeFactor = Number(block.properties.easeFactor) || 2.5;
            }

            if (block.uuid) {
              try {
                const fullBlock = await logseq.Editor.getBlock(block.uuid, { includeChildren: true });
                if (fullBlock && fullBlock.children) {
                  for (const child of (fullBlock.children as any[])) {
                    const cText: string = child.content || '';
                    if (cText.toLowerCase().includes('translation::')) {
                      translation = cText.replace(/translation::/i, '').trim();
                    } else if (cText.toLowerCase().includes('definition:')) {
                      definition = cText.replace(/[-*]?\s*\*\*definition\*\*:\s*/i, '').replace(/definition:\s*/i, '').trim();
                    } else if (cText.toLowerCase().includes('context:')) {
                      contextSentence = cText.replace(/[-*]?\s*\*\*context\*\*:\s*/i, '').replace(/context:\s*/i, '').replace(/^"|"$/g, '').trim();
                    }
                  }
                }
              } catch {}
            }

            let deckPath = pageName;
            try {
              let cur = block;
              const pathParts: string[] = [];
              while (cur && cur.parent && cur.parent.id) {
                const parentBlock = await logseq.Editor.getBlock(cur.parent.id);
                if (!parentBlock || !parentBlock.content) break;
                const pClean = cleanBlockText(parentBlock.content).replace(/#deck\b/g, '').trim();
                if (pClean && !pClean.startsWith('title::') && !pClean.startsWith('tags::')) {
                  pathParts.unshift(pClean.slice(0, 30));
                }
                cur = parentBlock;
              }
              if (pathParts.length > 0) {
                deckPath = `${pageName}/${pathParts.join('/')}`;
              }
            } catch {}

            importedItems.push({
              word,
              translation: translation || word,
              phonetic,
              partOfSpeech,
              definition: definition || translation,
              contextSentence,
              deckPath,
              sourcePage: pageName,
              dueDate,
              interval,
              easeFactor,
              repetition,
            });
          }
        }
      } catch (err: any) {
        console.warn('Error querying Logseq datascript #card:', err);
      }
    }

    if (importedItems.length === 0 && sourceFiles.length > 0) {
      for (const sf of sourceFiles) {
        if (typeof sf.content !== 'string' || !sf.content.includes('#card')) continue;
        const lines = sf.content.split(/\r?\n/);
        const pageName = sf.name.replace(/\.(md|org)$/, '');
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (!l.includes('#card')) continue;
          const clean = cleanBlockText(l).replace(/#card\b/g, '').trim();
          if (clean) {
            importedItems.push({
              word: clean,
              translation: clean,
              deckPath: pageName,
              sourcePage: pageName,
            });
          }
        }
      }
    }

    if (importedItems.length > 0) {
      const res = ankiStore.importFromLogseqBlocks(importedItems);
      updateAnkiUI();
      showToast(`📥 Đã quét và nhập ${res.added} thẻ mới, cập nhật ${res.updated} thẻ từ Graph!`);
    } else {
      showToast('ℹ️ Không tìm thấy khối nào có gắn #card trong Graph.');
    }
  });

  // ── Export for Anki Desktop (.txt TSV) ──
  document.getElementById('anki-export-desktop-btn')?.addEventListener('click', () => {
    const tsv = ankiStore.exportToAnkiTSV(currentSelectedDeck);
    const today = new Date().toISOString().split('T')[0];
    const blob = new Blob(['\uFEFF' + tsv], { type: 'text/tab-separated-values;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Anki_Desktop_Import_${today}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('📦 Đã xuất file Anki Desktop (.txt). Hãy mở Anki -> File -> Import để nhập dữ liệu!');
  });

  // ── Full JSON Backup ──
  document.getElementById('anki-backup-btn')?.addEventListener('click', () => {
    const json = ankiStore.exportBackupJSON();
    const today = new Date().toISOString().split('T')[0];
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Anki_Vocabulary_Backup_${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('💾 Đã tải file sao lưu JSON an toàn về máy!');
  });

  // ── Restore from Backup JSON ──
  const restoreFileInput = document.getElementById('anki-restore-file-input') as HTMLInputElement;
  document.getElementById('anki-restore-btn')?.addEventListener('click', () => {
    restoreFileInput?.click();
  });

  restoreFileInput?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const replaceChoice = confirm(
        `📥 BẠN MUỐN KHÔI PHỤC THEO HÌNH THỨC NÀO?\n\n` +
        `• [OK]: GỘP (Merge) - Giữ nguyên từ cũ và nạp thêm từ mới từ file backup.\n` +
        `• [Cancel]: GHI ĐÈ (Replace) - Xóa hết thẻ hiện tại và nạp chính xác từ file backup.`
      );

      const mode = replaceChoice ? 'merge' : 'replace';
      const result = ankiStore.importBackupJSON(text, mode);

      updateAnkiUI();
      showToast(`✅ Khôi phục thành công! (Thêm mới: ${result.added}, Cập nhật: ${result.updated}, Tổng: ${result.total} từ)`);
    } catch (err: any) {
      alert(`❌ Lỗi khi đọc file sao lưu: ${err.message}`);
    } finally {
      restoreFileInput.value = '';
    }
  });
}

function playGoogleTTS(text: string, lang = 'en') {
  if (!text || !text.trim()) return;
  const clean = text.trim();
  try {
    // 1. Primary Google Translate TTS Endpoint
    const primaryUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(clean)}`;
    const audio = new Audio(primaryUrl);
    audio.play().catch(() => {
      // 2. Secondary Google GTX TTS Endpoint
      const secondaryUrl = `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(clean)}`;
      new Audio(secondaryUrl).play().catch(() => {
        // 3. Fallback to Browser SpeechSynthesis
        if ('speechSynthesis' in window) {
          const u = new SpeechSynthesisUtterance(clean);
          u.lang = lang === 'vi' ? 'vi-VN' : 'en-US';
          window.speechSynthesis.speak(u);
        }
      });
    });
  } catch {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = lang === 'vi' ? 'vi-VN' : 'en-US';
      window.speechSynthesis.speak(u);
    }
  }
}

let mouseDownPos = { x: 0, y: 0 };
let lastClosePopupTime = 0;

function clearAllSelections() {
  try { window.getSelection()?.removeAllRanges(); } catch {}
  try { (window.top ?? window).getSelection?.()?.removeAllRanges?.(); } catch {}
}

function initGlobalSelectionListener() {
  const handleMouseDown = (e: MouseEvent) => {
    mouseDownPos = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = (e: MouseEvent) => {
    // If popup was just closed within last 350ms, do NOT re-trigger selection lookup
    if (Date.now() - lastClosePopupTime < 350) {
      return;
    }

    // Check if auto popup on selection is enabled in settings
    const settings = settingsStore.getSettings();
    if (settings.autoPopupOnSelect === false) {
      return;
    }

    const target = e.target as HTMLElement;
    if (target && target.closest && (target.closest('#app') || target.closest('.btn') || target.closest('button') || target.closest('select') || target.closest('input') || target.closest('#dict-popup-modal'))) {
      return;
    }

    setTimeout(() => {
      if (Date.now() - lastClosePopupTime < 350) {
        return;
      }
      const selText = getTopFrameSelection();
      if (selText && selText.length >= 2 && selText.length <= 3000) {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        openDictionaryPopup(selText, false, undefined, target);
      }
    }, 60);
  };

  try {
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    if (window.top && window.top !== window && window.top.document) {
      window.top.document.addEventListener('mousedown', handleMouseDown);
      window.top.document.addEventListener('mouseup', handleMouseUp);
    }
    if (window.parent && window.parent !== window && window.parent !== window.top && window.parent.document) {
      window.parent.document.addEventListener('mousedown', handleMouseDown);
      window.parent.document.addEventListener('mouseup', handleMouseUp);
    }
  } catch (err) {
    console.warn('initGlobalSelectionListener failed:', err);
  }
}

function initOutsideClickListener() {
  const handleOutsideClick = (e: MouseEvent) => {
    const modal = document.getElementById('dict-popup-modal');
    if (!modal || modal.classList.contains('hidden')) return;

    const target = e.target as HTMLElement;
    // If clicked inside the popup card itself or its buttons, do not close
    if (target && target.closest && target.closest('.popup-card')) {
      return;
    }

    // Clicked outside popup -> Close popup immediately
    closePluginUI();
  };

  try {
    document.addEventListener('mousedown', handleOutsideClick);
    if (window.top && window.top !== window && window.top.document) {
      window.top.document.addEventListener('mousedown', handleOutsideClick);
    }
    if (window.parent && window.parent !== window && window.parent !== window.top && window.parent.document) {
      window.parent.document.addEventListener('mousedown', handleOutsideClick);
    }
  } catch (err) {
    console.warn('initOutsideClickListener error:', err);
  }
}

/* ═══════════════════════════════════════════════════════
   HOVER WORD TRANSLATION & PRONUNCIATION POPUP
   ═══════════════════════════════════════════════════════ */
let hoverWordTimer: any = null;
let hoverHideTimer: any = null;
let currentHoveredWord: string | null = null;
let currentHoveredTooltipInfo: { word: string; translation: string; phonetic?: string; deckPath?: string } | null = null;
let isFullAppOpen: boolean = false;

function getTopDoc(): Document {
  try {
    if (window.top && window.top.document) {
      return window.top.document;
    }
  } catch {}
  return document;
}

function findTranslatedWord(wordOrPhrase: string, contextSentence?: string): { word: string; translation: string; phonetic?: string; partOfSpeech?: string; deckPath?: string } | null {
  if (!wordOrPhrase || wordOrPhrase.trim().length < 2) return null;
  const clean = wordOrPhrase.trim().toLowerCase().replace(/^[^\w\u00C0-\u024F\u1EA0-\u1EF9]+|[^\w\u00C0-\u024F\u1EA0-\u1EF9]+$/g, '');
  if (!clean || clean.length < 2) return null;

  const cards = ankiStore.getCards();

  // 1. Exact match in Anki Cards
  let card = cards.find(c => c.word.toLowerCase() === clean);
  
  // 2. Check multi-word phrase in saved cards if contextSentence provided
  if (!card && contextSentence && contextSentence.length > clean.length) {
    const cleanSent = contextSentence.toLowerCase();
    const candidateCards = cards.filter(c => {
      const cw = c.word.toLowerCase();
      return cw.includes(clean) && cleanSent.includes(cw);
    });
    if (candidateCards.length > 0) {
      candidateCards.sort((a, b) => b.word.length - a.word.length);
      card = candidateCards[0];
    }
  }

  // 3. Stemming & Suffix Variations (plurals, tenses, etc.)
  if (!card) {
    const stems = [
      clean.replace(/ies$/, 'y'),
      clean.replace(/ves$/, 'f'),
      clean.replace(/ses$/, 'sis'),
      clean.replace(/es$/, ''),
      clean.replace(/s$/, ''),
      clean.replace(/ing$/, ''),
      clean.replace(/ed$/, ''),
      clean.replace(/d$/, ''),
      clean.replace(/ly$/, ''),
      clean.replace(/ment$/, ''),
      clean.replace(/tion$/, ''),
      clean.replace(/sion$/, ''),
    ].filter(s => s.length >= 2 && s !== clean);

    for (const stem of stems) {
      card = cards.find(c => c.word.toLowerCase() === stem || c.word.toLowerCase().replace(/s$/, '') === stem);
      if (card) break;
    }
  }

  // 4. Reverse stem check (If saved card word is plural and user hovers singular)
  if (!card) {
    card = cards.find(c => {
      const cw = c.word.toLowerCase();
      return cw === clean + 's' || cw === clean + 'es' || cw.replace(/ies$/, 'y') === clean;
    });
  }

  if (card) {
    return {
      word: card.word,
      translation: card.translation,
      phonetic: card.phonetic,
      partOfSpeech: card.partOfSpeech,
      deckPath: card.deckPath || 'Inbox',
    };
  }

  // 5. Check in Dictionary Cache
  let cached = dictionary.getCached(clean);
  if (!cached) {
    const base = clean.replace(/(s|es|ed|ing)$/, '');
    if (base.length >= 3) {
      cached = dictionary.getCached(base);
    }
  }

  if (cached) {
    return {
      word: cached.word,
      translation: cached.translation,
      phonetic: cached.phonetic,
      partOfSpeech: cached.partOfSpeech,
      deckPath: 'Đã tra',
    };
  }

  return null;
}

function getWordAtPoint(doc: Document, x: number, y: number): { word: string; contextSentence?: string; rect?: DOMRect | null } | null {
  try {
    let textNode: Node | null = null;
    let offset = 0;

    if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (r) {
        if (r.startContainer.nodeType === Node.TEXT_NODE) {
          textNode = r.startContainer;
          offset = r.startOffset;
        } else if (r.startContainer.nodeType === Node.ELEMENT_NODE) {
          const parent = r.startContainer as HTMLElement;
          if (parent.childNodes && parent.childNodes.length > 0) {
            const childIdx = Math.min(Math.max(0, r.startOffset), parent.childNodes.length - 1);
            const child = parent.childNodes[childIdx];
            if (child && child.nodeType === Node.TEXT_NODE) {
              textNode = child;
              offset = 0;
            }
          }
        }
      }
    }

    if (!textNode || !textNode.nodeValue) {
      const el = doc.elementFromPoint(x, y);
      if (!el) return null;

      // Deep probe text nodes inside el to find exact bounding box
      const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let current = walker.nextNode();
      while (current) {
        const range = doc.createRange();
        range.selectNodeContents(current);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const rect = rects[i];
          if (x >= rect.left - 6 && x <= rect.right + 6 && y >= rect.top - 6 && y <= rect.bottom + 6) {
            textNode = current;
            offset = 0;
            break;
          }
        }
        if (textNode) break;
        current = walker.nextNode();
      }
    }

    if (!textNode || !textNode.nodeValue) {
      // Fallback: check matching translated words directly from element
      const el = doc.elementFromPoint(x, y);
      if (el && el.textContent) {
        const tokens = el.textContent.split(/\s+/);
        for (const t of tokens) {
          const cleanToken = t.replace(/^[^\w\u00C0-\u024F\u1EA0-\u1EF9]+|[^\w\u00C0-\u024F\u1EA0-\u1EF9]+$/g, '');
          if (cleanToken && cleanToken.length >= 2 && findTranslatedWord(cleanToken, el.textContent)) {
            return { word: cleanToken, contextSentence: el.textContent };
          }
        }
      }
      return null;
    }

    const text = textNode.nodeValue;
    if (offset >= text.length) offset = Math.max(0, text.length - 1);

    let start = offset;
    let end = offset;

    if (!/[\w\u00C0-\u024F\u1EA0-\u1EF9'-]/.test(text[start]) && start > 0 && /[\w\u00C0-\u024F\u1EA0-\u1EF9'-]/.test(text[start - 1])) {
      start--;
      end = start;
    }

    while (start > 0 && /[\w\u00C0-\u024F\u1EA0-\u1EF9'-]/.test(text[start - 1])) {
      start--;
    }
    while (end < text.length && /[\w\u00C0-\u024F\u1EA0-\u1EF9'-]/.test(text[end])) {
      end++;
    }

    let word = text.slice(start, end).trim();
    word = word.replace(/^[^\w\u00C0-\u024F\u1EA0-\u1EF9]+|[^\w\u00C0-\u024F\u1EA0-\u1EF9]+$/g, '');
    if (!word || word.length < 2) return null;

    let rect: DOMRect | null = null;
    try {
      const wordRange = doc.createRange();
      wordRange.setStart(textNode, start);
      wordRange.setEnd(textNode, end);
      rect = wordRange.getBoundingClientRect();
    } catch {}

    return { word, contextSentence: text, rect };
  } catch {
    return null;
  }
}

let currentHoveredTargetEl: HTMLElement | null = null;

async function saveHoverWordToAnki(info: { word: string; translation: string; phonetic?: string; deckPath?: string }) {
  const detectedDeck = await getCurrentLogseqBlockHierarchyPath(currentHoveredTargetEl || undefined);
  const targetDeck = (detectedDeck && detectedDeck !== 'Inbox') ? detectedDeck : (info.deckPath && info.deckPath !== 'Đã tra' ? info.deckPath : (detectedDeck || 'Inbox'));
  ankiStore.addCard({
    word: info.word,
    translation: info.translation,
    phonetic: info.phonetic,
    deckPath: targetDeck,
    sourcePage: targetDeck,
  });
  updateAnkiUI();
  showToast(`⭐ Đã lưu từ "${info.word}" vào Deck [${targetDeck}]!`);
}

function showHoverWordTooltip(info: { word: string; translation: string; phonetic?: string; deckPath?: string }, x: number, y: number, rect?: DOMRect | null, targetEl?: HTMLElement) {
  // If full app UI is open or quick dictionary modal is actively open, don't show hover tooltip
  if (isFullAppOpen) return;
  const dictModal = document.getElementById('dict-popup-modal');
  if (dictModal && !dictModal.classList.contains('hidden')) return;

  currentHoveredTooltipInfo = info;
  currentHoveredTargetEl = targetEl || null;
  const topDoc = getTopDoc();
  const topWin = (topDoc.defaultView || window.top || window) as Window;
  let tooltip = topDoc.getElementById('logseq-hover-word-tooltip');
  if (!tooltip) {
    tooltip = topDoc.createElement('div');
    tooltip.id = 'logseq-hover-word-tooltip';
    tooltip.style.position = 'fixed';
    tooltip.style.zIndex = '2147483647';
    tooltip.style.pointerEvents = 'auto';
    tooltip.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    tooltip.style.transition = 'opacity 0.12s ease';
    topDoc.body.appendChild(tooltip);

    tooltip.addEventListener('mouseenter', () => {
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
    });
    tooltip.addEventListener('mouseleave', () => {
      hoverHideTimer = setTimeout(() => {
        hideHoverWordTooltip();
        hoverHideTimer = null;
      }, 250);
    });
  }

  const initialDeck = info.deckPath && info.deckPath !== 'Đã tra' ? info.deckPath : '...';

  tooltip.innerHTML = `
    <div style="background:#0f172a;border:1px solid #6366f1;border-radius:10px;padding:8px 12px;box-shadow:0 12px 28px -4px rgba(0,0,0,0.8),0 0 16px rgba(99,102,241,0.25);min-width:210px;max-width:340px;display:flex;flex-direction:column;gap:4px;color:#fff;user-select:none;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
        <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
          <span style="font-weight:700;font-size:13px;color:#fff;">${escapeHtml(info.word)}</span>
          ${info.phonetic ? `<span style="font-size:11px;color:#a5b4fc;font-family:Consolas,monospace;">${escapeHtml(info.phonetic)}</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <button id="lsq-hover-audio-btn" style="border:1px solid rgba(99,102,241,0.3);background:rgba(99,102,241,0.15);color:#a5b4fc;border-radius:4px;padding:2px 5px;cursor:pointer;font-size:11px;line-height:1;display:inline-flex;align-items:center;gap:2px;" title="Phát âm Google TTS (Phím tắt: R hoặc 5)">🔊 <span style="font-size:9px;opacity:0.8;">[R]</span></button>
          <button id="lsq-hover-save-btn" style="border:1px solid rgba(245,158,11,0.3);background:rgba(245,158,11,0.15);color:#fbbf24;border-radius:4px;padding:2px 5px;cursor:pointer;font-size:11px;line-height:1;display:inline-flex;align-items:center;gap:2px;" title="Lưu vào Deck theo phân cấp Block (Phím tắt: S)">⭐ <span style="font-size:9px;opacity:0.8;">[S]</span></button>
          <button id="lsq-hover-detail-btn" style="border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#cbd5e1;border-radius:4px;padding:2px 5px;cursor:pointer;font-size:11px;line-height:1;display:inline-flex;align-items:center;gap:2px;" title="Tra chi tiết (Phím tắt: D hoặc Enter)">🔍 <span style="font-size:9px;opacity:0.8;">[D]</span></button>
        </div>
      </div>
      <div style="font-size:13px;font-weight:600;color:#34d399;line-height:1.3;">${escapeHtml(info.translation)}</div>
      <div id="lsq-hover-deck-badge" style="font-size:10px;color:rgba(165,180,252,0.8);margin-top:2px;">📂 ${escapeHtml(initialDeck)}</div>
    </div>
  `;

  // Asynchronously detect current block hierarchy deck and update deck badge in real-time
  getCurrentLogseqBlockHierarchyPath(targetEl).then(detected => {
    const badgeEl = topDoc.getElementById('lsq-hover-deck-badge');
    if (badgeEl && detected) {
      badgeEl.textContent = `📂 ${detected}`;
    }
  }).catch(() => {});

  const vw = topWin.innerWidth || 1200;
  const vh = topWin.innerHeight || 800;

  let targetX = x;
  let targetY = y;
  let showAbove = true;

  if (rect && rect.width > 0 && rect.height > 0) {
    targetX = rect.left + rect.width / 2;
    if (rect.top > 120) {
      targetY = rect.top - 8;
      showAbove = true;
    } else {
      targetY = rect.bottom + 8;
      showAbove = false;
    }
  } else {
    if (y > 120) {
      targetY = y - 10;
      showAbove = true;
    } else {
      targetY = y + 20;
      showAbove = false;
    }
  }

  // Constrain horizontally so the card never clips off screen
  const posX = Math.max(140, Math.min(vw - 140, targetX));
  const posY = Math.max(10, Math.min(vh - 10, targetY));

  tooltip.style.left = `${posX}px`;
  tooltip.style.top = `${posY}px`;
  tooltip.style.transform = showAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
  tooltip.style.display = 'block';
  tooltip.style.opacity = '1';

  // Wire buttons
  const audioBtn = topDoc.getElementById('lsq-hover-audio-btn');
  if (audioBtn) {
    audioBtn.onclick = (e) => {
      e.stopPropagation();
      playGoogleTTS(info.word);
    };
  }

  const saveBtn = topDoc.getElementById('lsq-hover-save-btn');
  if (saveBtn) {
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      saveHoverWordToAnki(info);
    };
  }

  const detailBtn = topDoc.getElementById('lsq-hover-detail-btn');
  if (detailBtn) {
    detailBtn.onclick = (e) => {
      e.stopPropagation();
      hideHoverWordTooltip();
      smartLookupAndOpenPopup(info.word);
    };
  }
}

function hideHoverWordTooltip() {
  const topDoc = getTopDoc();
  const tooltip = topDoc.getElementById('logseq-hover-word-tooltip');
  if (tooltip) {
    tooltip.style.opacity = '0';
    setTimeout(() => {
      if (tooltip.style.opacity === '0') {
        tooltip.style.display = 'none';
      }
    }, 150);
  }
  currentHoveredWord = null;
  currentHoveredTooltipInfo = null;
}

function initHoverWordListener() {
  const handleMouseMove = (e: MouseEvent) => {
    const settings = settingsStore.getSettings();
    if (settings.hoverTranslateOnHover === false) {
      hideHoverWordTooltip();
      return;
    }

    const target = e.target as HTMLElement;
    // If hovering inside hover tooltip itself or inside plugin UI elements, do not close or re-trigger
    if (target && target.closest && (target.closest('#logseq-hover-word-tooltip') || target.closest('#hover-word-tooltip') || target.closest('#app') || target.closest('.popup-card'))) {
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
      return;
    }

    const doc = target?.ownerDocument || getTopDoc();
    const wordResult = getWordAtPoint(doc, e.clientX, e.clientY);

    if (!wordResult) {
      if (hoverWordTimer) {
        clearTimeout(hoverWordTimer);
        hoverWordTimer = null;
      }
      if (!hoverHideTimer) {
        hoverHideTimer = setTimeout(() => {
          hideHoverWordTooltip();
          hoverHideTimer = null;
        }, 250);
      }
      return;
    }

    const word = wordResult.word;
    if (word.toLowerCase() === currentHoveredWord?.toLowerCase()) {
      if (hoverHideTimer) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
      }
      return;
    }

    const translatedInfo = findTranslatedWord(word, wordResult.contextSentence);
    if (!translatedInfo) {
      if (hoverWordTimer) {
        clearTimeout(hoverWordTimer);
        hoverWordTimer = null;
      }
      if (!hoverHideTimer) {
        hoverHideTimer = setTimeout(() => {
          hideHoverWordTooltip();
          hoverHideTimer = null;
        }, 250);
      }
      return;
    }

    // Found pre-translated word -> Show tooltip after 220ms hover debounce
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
    if (hoverWordTimer) clearTimeout(hoverWordTimer);

    hoverWordTimer = setTimeout(() => {
      currentHoveredWord = word;
      showHoverWordTooltip(translatedInfo, e.clientX, e.clientY, wordResult.rect, target);
    }, 220);
  };

  const handleScroll = () => {
    hideHoverWordTooltip();
  };

  try {
    document.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('scroll', handleScroll, { passive: true });

    if (window.top && window.top !== window && window.top.document) {
      window.top.document.addEventListener('mousemove', handleMouseMove);
      window.top.addEventListener('scroll', handleScroll, { passive: true });
    }
    if (window.parent && window.parent !== window && window.parent !== window.top && window.parent.document) {
      window.parent.document.addEventListener('mousemove', handleMouseMove);
      window.parent.addEventListener('scroll', handleScroll, { passive: true });
    }
  } catch (err) {
    console.warn('initHoverWordListener failed:', err);
  }
}

function hideSubSelectionToolbar() {
  const subToolbar = document.getElementById('sub-selection-toolbar');
  subToolbar?.classList.add('hidden');
  currentSubSelectionText = '';
}

/**
 * Searches for a pre-translated matching block between Graph Nguồn & Graph Đích.
 * Returns { sourceText, destText } if found, or null.
 */
async function findMatchingPairInGraphs(text: string): Promise<{ sourceText: string; destText: string } | null> {
  const cleanInput = cleanBlockText(text).toLowerCase();
  if (!cleanInput) return null;

  // 1. Search in-memory session translations
  // 1. Search in-memory session translations starting from sourceFiles
  if (sourceFiles.length > 0) {
    for (let idx = 0; idx < sourceFiles.length; idx++) {
      const srcFile = sourceFiles[idx];
      if (!srcFile || typeof srcFile.content !== 'string') continue;
      const destFile = destinationFiles[idx] || destinationFiles.find((d) => d.name === srcFile.name || d.path === srcFile.path);
      const destContent = destFile && typeof destFile.content === 'string' ? destFile.content : '';

      const srcLines = srcFile.content.split(/\r?\n/);
      const destLines = destContent.split(/\r?\n/);

      for (let i = 0; i < srcLines.length; i++) {
        const sClean = cleanBlockText(srcLines[i]);
        const dClean = cleanBlockText(destLines[i] || '');
        if (!sClean) continue;

        if (sClean.toLowerCase() === cleanInput || (dClean && dClean.toLowerCase() === cleanInput)) {
          return {
            sourceText: sClean,
            destText: dClean || sClean,
          };
        }
      }
    }
  }

  // 2. Search on disk starting from Source Graph directory FIRST
  const nodeFs = scanner.getNodeFs();
  if (nodeFs) {
    const settings = settingsStore.getSettings();
    let srcDir = settings.lastSourcePath?.replace(/^[📌📁]\s*/, '').replace(/^Active Graph:\s*/, '').replace(/^Path:\s*/, '').trim();
    let destDir = settings.lastDestPath?.replace(/^[🎯📌]\s*/, '').replace(/^Path:\s*/, '').trim();

    if (srcDir && nodeFs.fs.existsSync(srcDir)) {
      try {
        const pagesSrc = nodeFs.path.join(srcDir, 'pages');
        if (nodeFs.fs.existsSync(pagesSrc)) {
          const files = nodeFs.fs.readdirSync(pagesSrc);
          for (const f of files) {
            if (!f.endsWith('.md')) continue;
            const sFullPath = nodeFs.path.join(pagesSrc, f);
            if (!nodeFs.fs.existsSync(sFullPath)) continue;

            const sContent = nodeFs.fs.readFileSync(sFullPath, 'utf-8');
            const sLines = sContent.split(/\r?\n/);

            for (let i = 0; i < sLines.length; i++) {
              const sClean = cleanBlockText(sLines[i]);
              if (sClean && sClean.toLowerCase() === cleanInput) {
                let dClean = '';
                if (destDir && nodeFs.fs.existsSync(destDir)) {
                  const dPages = nodeFs.path.join(destDir, 'pages');
                  if (nodeFs.fs.existsSync(dPages)) {
                    const dFiles = nodeFs.fs.readdirSync(dPages);
                    const matchedDF = dFiles.find((df: string) => df.endsWith('.md'));
                    if (matchedDF) {
                      const dFullPath = nodeFs.path.join(dPages, matchedDF);
                      const dContent = nodeFs.fs.readFileSync(dFullPath, 'utf-8');
                      const dLines = dContent.split(/\r?\n/);
                      dClean = cleanBlockText(dLines[i] || '');
                    }
                  }
                }
                return {
                  sourceText: sClean,
                  destText: dClean || sClean,
                };
              }
            }
          }
        }
      } catch (err) {
        console.warn('[findMatchingPairInGraphs] Error reading disk:', err);
      }
    }
  }

  return null;
}

function showFullAppUI() {
  isFullAppOpen = true;
  document.body.classList.remove('popup-only');
  document.getElementById('app')?.classList.remove('hidden');
  document.getElementById('dict-popup-modal')?.classList.add('hidden');
  if (inLogseq) logseq.showMainUI();
}

function showPopupOnlyUI(forceReposition: boolean = true) {
  isFullAppOpen = false;
  document.body.classList.add('popup-only');
  document.getElementById('app')?.classList.add('hidden');
  const modal = document.getElementById('dict-popup-modal');
  if (modal) {
    modal.classList.remove('hidden');
    if (forceReposition) {
      const pos = getSelectionPosition();
      requestAnimationFrame(() => positionPopupNear(pos.x, pos.y));
    }
  }
  if (inLogseq) logseq.showMainUI();
}

function closePluginUI() {
  isFullAppOpen = false;
  lastClosePopupTime = Date.now();
  document.getElementById('dict-popup-modal')?.classList.add('hidden');
  document.getElementById('app')?.classList.add('hidden');
  document.body.classList.remove('popup-only');
  clearAllSelections();
  if (inLogseq) logseq.hideMainUI();
}

interface PopupContextSession {
  wholeText: string;
  wholeResult: DictionaryResult | null;
  activeSubWord?: string;
}
let currentPopupSession: PopupContextSession | null = null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderPopupWordContainer(wholeText: string, highlightedSubWord?: string) {
  const popupWordEl = document.getElementById('popup-word');
  if (!popupWordEl) return;

  if (!highlightedSubWord || highlightedSubWord === wholeText) {
    popupWordEl.textContent = wholeText;
    popupWordEl.title = '💡 Bôi đen bất kỳ từ hoặc cụm từ con ở đây để tra ngay!';
    return;
  }

  // Highlight the selected subword inside the whole phrase
  const safeWhole = escapeHtml(wholeText);
  const safeSub = escapeRegex(escapeHtml(highlightedSubWord));
  const regex = new RegExp(`(${safeSub})`, 'gi');
  popupWordEl.innerHTML = safeWhole.replace(regex, '<mark class="popup-sub-highlight">$1</mark>');
  popupWordEl.title = `Đang tra từ: "${highlightedSubWord}". Bấm nút "📄 Cả cụm" để quay lại bản dịch cả câu.`;
}

function restoreWholeLineTranslation() {
  if (!currentPopupSession?.wholeText) return;

  currentPopupSession.activeSubWord = undefined;
  renderPopupWordContainer(currentPopupSession.wholeText);
  document.getElementById('popup-whole-line-btn')?.classList.add('hidden');

  if (currentPopupSession.wholeResult) {
    currentDictResult = currentPopupSession.wholeResult;
    setText('popup-pos', currentDictResult.partOfSpeech || 'phrase');
    setText('popup-phonetic', currentDictResult.phonetic || '/phonetic/');
    const transInp = document.getElementById('popup-translation-input') as HTMLTextAreaElement;
    if (transInp) {
      transInp.value = currentDictResult.translation;
      autoResizeTextarea(transInp);
    }

    const ul = document.getElementById('popup-definitions-list')!;
    ul.innerHTML = '';
    for (const d of currentDictResult.definitions) {
      const li = document.createElement('li');
      li.textContent = d.definition + (d.example ? ` — "${d.example}"` : '');
      ul.appendChild(li);
    }
  } else {
    openDictionaryPopup(currentPopupSession.wholeText, false);
  }
}

function autoResizeTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.max(42, el.scrollHeight)}px`;
}

/**
 * Smart lookup: Tận dụng bản dịch có sẵn từ Graph Nguồn & Đích (0 API call).
 * Chỉ gọi API khi tra từ/cụm từ nhỏ không thuộc Graph.
 */
async function smartLookupAndOpenPopup(text: string, contextSentence?: string) {
  showPopupOnlyUI(true);
  await openDictionaryPopup(text, false, contextSentence);
}

function cleanBlockTitle(content: string): string {
  if (!content) return '';
  let line = content.split(/\r?\n/)[0].trim();
  // Remove markdown headings like ###, bullets, checkboxes, tags like #card
  line = line
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/#\w+/g, '')
    .replace(/\[\[(.*?)\]\]/g, '$1')
    .replace(/[:：].*$/, '') // remove properties or colons
    .replace(/[/\\]+/g, ' - ') // Replace slashes with dash so they don't break deck path
    .replace(/\s+/g, ' ')
    .trim();
  return line;
}

async function getBlockFromSelectionOrCursor(target?: HTMLElement): Promise<any> {
  if (!inLogseq) return null;
  try {
    // 1. Try currently editing block first
    const curr = await logseq.Editor.getCurrentBlock();
    if (curr) return curr;

    // 2. Try from target element in DOM
    let el: HTMLElement | null = target || null;
    if (!el && window.top) {
      const sel = window.top.getSelection();
      if (sel && sel.anchorNode) {
        el = (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode) as HTMLElement;
      }
    }

    if (el) {
      const blockEl = el.closest('[blockid]') || el.closest('[data-block-id]') || el.closest('.ls-block');
      const blockUuid = blockEl?.getAttribute('blockid') || blockEl?.getAttribute('data-block-id');
      if (blockUuid) {
        const b = await logseq.Editor.getBlock(blockUuid);
        if (b) return b;
      }
    }

    // 3. Try getSelectedBlocks
    const selectedBlocks = await logseq.Editor.getSelectedBlocks();
    if (selectedBlocks && selectedBlocks.length > 0) {
      return selectedBlocks[0];
    }
  } catch (err) {
    console.warn('[getBlockFromSelectionOrCursor]', err);
  }
  return null;
}

async function getCurrentLogseqBlockHierarchyPath(targetEl?: HTMLElement): Promise<string> {
  if (!inLogseq) return 'Inbox';
  try {
    // 1. Get current block & page
    let block: any = await getBlockFromSelectionOrCursor(targetEl);
    let pageName = '';

    if (block?.page?.id) {
      const p = await logseq.Editor.getPage(block.page.id);
      pageName = p?.originalName || p?.name || '';
    }

    if (!pageName) {
      const currPage = await logseq.Editor.getCurrentPage();
      pageName = currPage?.originalName || currPage?.name || '';
    }

    if (!pageName) pageName = 'Inbox';
    pageName = pageName.replace(/[/\\]+/g, ' - ').trim();

    if (!block) return pageName;

    // 2. Traverse up the entire parent block chain without artificial limits
    const parentSegments: string[] = [];
    let curBlock = block;
    const visitedIds = new Set<string | number>();

    while (curBlock && curBlock.parent && (curBlock.parent.id || curBlock.parent.uuid)) {
      const parentId = curBlock.parent.id || curBlock.parent.uuid;
      if (!parentId || visitedIds.has(parentId)) break;
      visitedIds.add(parentId);

      try {
        const parentBlock = await logseq.Editor.getBlock(parentId);
        if (!parentBlock || parentBlock.id === curBlock.page?.id || parentBlock.uuid === curBlock.page?.id) break;

        if (parentBlock.content) {
          const title = cleanBlockTitle(parentBlock.content);
          if (title && title.length >= 1 && !title.startsWith(':') && !title.startsWith('title::')) {
            parentSegments.unshift(title);
          }
        }
        curBlock = parentBlock;
      } catch {
        break;
      }
    }

    if (parentSegments.length > 0) {
      return `${pageName}/${parentSegments.join('/')}`;
    }

    return pageName || 'Inbox';
  } catch (err) {
    console.warn('[getCurrentLogseqBlockHierarchyPath] Error:', err);
    return 'Inbox';
  }
}

async function openDictionaryPopup(text: string, isSubLookup: boolean = false, parentContext?: string, targetEl?: HTMLElement) {
  showPopupOnlyUI(!isSubLookup); // reposition only on new selection, keep stable on sub-selection

  const modal = document.getElementById('dict-popup-modal');
  modal?.classList.remove('hidden');

  const transInp = document.getElementById('popup-translation-input') as HTMLTextAreaElement;
  if (transInp) {
    transInp.value = '⏳ Đang dịch...';
    autoResizeTextarea(transInp);
  }
  setText('popup-phonetic', '⏳ Đang tra cứu...');
  setText('popup-pos', isSubLookup ? 'từ/cụm con' : 'câu/cụm từ');

  // Auto-detect full block hierarchy path (Page/ParentBlock/SubBlock) and set deck selector
  const deckInp = document.getElementById('popup-deck-input') as HTMLInputElement;
  if (deckInp && (!deckInp.value || !isSubLookup)) {
    const detectedPath = await getCurrentLogseqBlockHierarchyPath(targetEl);
    deckInp.value = (currentSelectedDeck && currentSelectedDeck !== 'ALL') ? currentSelectedDeck : (detectedPath || 'Inbox');
  }

  // Populate datalist with all known decks
  const datalist = document.getElementById('popup-deck-datalist');
  if (datalist) {
    datalist.innerHTML = '';
    for (const d of ankiStore.getDeckList()) {
      const opt = document.createElement('option');
      opt.value = d;
      datalist.appendChild(opt);
    }
  }

  const wholeLineBtn = document.getElementById('popup-whole-line-btn');

  if (!isSubLookup) {
    // New whole lookup
    currentPopupSession = {
      wholeText: text,
      wholeResult: null,
      activeSubWord: undefined,
    };
    renderPopupWordContainer(text);
    wholeLineBtn?.classList.add('hidden');
  } else {
    // Sub-word lookup within wholeText
    const wholeText = currentPopupSession?.wholeText || parentContext || text;
    if (!currentPopupSession) {
      currentPopupSession = { wholeText, wholeResult: currentDictResult };
    }
    currentPopupSession.activeSubWord = text;
    renderPopupWordContainer(wholeText, text);
    wholeLineBtn?.classList.remove('hidden');
  }

  try {
    const lookupContext = isSubLookup ? (currentPopupSession?.wholeText || parentContext) : parentContext;
    currentDictResult = await dictionary.lookupWord(text, lookupContext);

    if (!isSubLookup && currentPopupSession) {
      currentPopupSession.wholeResult = currentDictResult;
    }

    setText('popup-pos', currentDictResult.partOfSpeech || (isSubLookup ? 'từ con' : 'cụm từ'));
    setText('popup-phonetic', currentDictResult.phonetic || '/phonetic/');
    if (transInp) {
      transInp.value = currentDictResult.translation;
      autoResizeTextarea(transInp);
    }

    const ul = document.getElementById('popup-definitions-list')!;
    ul.innerHTML = '';
    for (const d of currentDictResult.definitions) {
      const li = document.createElement('li');
      li.textContent = d.definition + (d.example ? ` — "${d.example}"` : '');
      ul.appendChild(li);
    }
  } catch (err: any) {
    if (transInp) transInp.value = `Lỗi: ${err.message}`;
  }
}

function updateSourceFilesState() {
  const btn = document.getElementById('open-file-preview-btn');
  const selectedCount = sourceFiles.filter(f => f.selected !== false).length;

  if (sourceFiles.length > 0) {
    btn?.classList.remove('hidden');
    if (btn) btn.textContent = `📋 Chọn File (${selectedCount}/${sourceFiles.length})`;
  } else {
    btn?.classList.add('hidden');
  }
}

function renderFileChecklistModal(filterTerm = '') {
  const container = document.getElementById('file-list-container');
  const modalSelected = document.getElementById('modal-selected-count');
  const modalTotal = document.getElementById('modal-total-count');

  if (!container) return;
  container.innerHTML = '';

  const selectedCount = sourceFiles.filter(f => f.selected !== false).length;
  if (modalSelected) modalSelected.textContent = `${selectedCount}`;
  if (modalTotal) modalTotal.textContent = `${sourceFiles.length}`;

  const filtered = sourceFiles.filter(f => !filterTerm || f.path.toLowerCase().includes(filterTerm) || f.name.toLowerCase().includes(filterTerm));

  for (const file of filtered) {
    const isChecked = file.selected !== false;
    const item = document.createElement('div');
    item.className = 'file-check-item';
    item.innerHTML = `
      <div class="file-check-left">
        <input type="checkbox" ${isChecked ? 'checked' : ''} />
        <span class="file-badge ${file.type}">${file.type}</span>
        <span>${file.path}</span>
      </div>
    `;

    const checkbox = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
    item.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }
      file.selected = checkbox.checked;
      updateSourceFilesState();
      const newSelectedCount = sourceFiles.filter(f => f.selected !== false).length;
      if (modalSelected) modalSelected.textContent = `${newSelectedCount}`;
    });

    container.appendChild(item);
  }
}

/* ═══════════════════════════════════════
   FILE READERS
   ═══════════════════════════════════════ */
async function readDirHandle(handle: any, base = ''): Promise<LogseqFile[]> {
  const out: LogseqFile[] = [];
  for await (const entry of handle.values()) {
    const p = base ? `${base}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.md') || lower.endsWith('.org')) {
        const f = await entry.getFile();
        const type = p.startsWith('journals') ? 'journal' : 'page';
        out.push({ name: entry.name, path: p, content: await f.text(), type, selected: true });
      } else if (p.startsWith('logseq/') || lower === 'config.edn' || lower === 'custom.css') {
        const f = await entry.getFile();
        out.push({ name: entry.name, path: p, content: await f.text(), type: 'config', selected: true });
      } else {
        // Assets, images, attachments, binary files
        const f = await entry.getFile();
        const buf = await f.arrayBuffer();
        out.push({ name: entry.name, path: p, content: new Uint8Array(buf), type: 'asset', selected: true });
      }
    } else if (entry.kind === 'directory') {
      out.push(...await readDirHandle(entry, p));
    }
  }
  return out;
}

async function readFileList(list: FileList): Promise<LogseqFile[]> {
  const out: LogseqFile[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const parts = f.webkitRelativePath.split('/');
    parts.shift();
    const rel = parts.join('/') || f.name;
    const lower = f.name.toLowerCase();

    if (lower.endsWith('.md') || lower.endsWith('.org')) {
      const type = rel.startsWith('journals') ? 'journal' : 'page';
      out.push({ name: f.name, path: rel, content: await f.text(), type, selected: true });
    } else if (rel.startsWith('logseq/') || lower === 'config.edn' || lower === 'custom.css') {
      out.push({ name: f.name, path: rel, content: await f.text(), type: 'config', selected: true });
    } else {
      out.push({ name: f.name, path: rel, content: new Uint8Array(await f.arrayBuffer()), type: 'asset', selected: true });
    }
  }
  return out;
}

async function readSourceGraphFromPath(sourcePathStr: string): Promise<LogseqFile[]> {
  const out: LogseqFile[] = [];
  const nodeFs = scanner.getNodeFs();
  let cleanPath = sourcePathStr
    .replace(/^[📌📁🎯]\s*/, '')
    .replace(/^Path:\s*/, '')
    .replace(/^Active Graph:\s*/, '')
    .replace(/\(\d+\s*files?\)/gi, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  // If in Logseq, resolve current graph path if cleanPath is not a valid directory or is Active Graph
  if (inLogseq && (!cleanPath || !nodeFs || !nodeFs.fs.existsSync(cleanPath) || sourcePathStr.includes('Active Graph'))) {
    try {
      const curr = await logseq.App.getCurrentGraph();
      if (curr?.path) cleanPath = curr.path;
    } catch {}
  }

  if (nodeFs && cleanPath && nodeFs.fs.existsSync(cleanPath)) {
    // 1. Scan root directory files (e.g. index.md, readme.md)
    try {
      const rootEntries = nodeFs.fs.readdirSync(cleanPath, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          if (lower.endsWith('.md') || lower.endsWith('.org')) {
            const fullP = nodeFs.path.join(cleanPath, entry.name);
            const content = nodeFs.fs.readFileSync(fullP, 'utf-8');
            out.push({ name: entry.name, path: `pages/${entry.name}`, content, type: 'page', selected: true });
          }
        }
      }
    } catch {}

    // 2. Scan subfolders recursively (pages, journals, assets, logseq)
    const scanFolder = (subDir: string, defaultType: 'page' | 'journal' | 'asset' | 'config') => {
      const fullDir = nodeFs.path.join(cleanPath, subDir);
      if (!nodeFs.fs.existsSync(fullDir)) return;

      const scanRecursive = (dir: string, baseRel: string) => {
        const entries = nodeFs.fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullP = nodeFs.path.join(dir, entry.name);
          const relP = baseRel ? `${baseRel}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            scanRecursive(fullP, relP);
          } else if (entry.isFile()) {
            const lower = entry.name.toLowerCase();
            if (defaultType === 'page' || defaultType === 'journal') {
              if (lower.endsWith('.md') || lower.endsWith('.org')) {
                const content = nodeFs.fs.readFileSync(fullP, 'utf-8');
                out.push({ name: entry.name, path: relP, content, type: defaultType, selected: true });
              }
            } else if (defaultType === 'config') {
              const content = nodeFs.fs.readFileSync(fullP, 'utf-8');
              out.push({ name: entry.name, path: relP, content, type: 'config', selected: true });
            } else {
              // Asset binary file
              const rawBuf = nodeFs.fs.readFileSync(fullP);
              const u8 = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
              out.push({ name: entry.name, path: relP, content: u8, type: 'asset', selected: true });
            }
          }
        }
      };

      scanRecursive(fullDir, subDir);
    };

    scanFolder('pages', 'page');
    scanFolder('journals', 'journal');
    scanFolder('assets', 'asset');
    scanFolder('logseq', 'config');

    if (out.length > 0) return out;
  }

  // Fallback to active graph API if Node fs path scanning not applicable
  if (inLogseq) {
    return await readLogseqActiveGraph();
  }

  return out;
}

async function fetchLogseqAssetData(rawPath: string): Promise<Uint8Array | null> {
  // 1. Try Logseq makeUrl + fetch
  if (inLogseq && logseq.Assets && typeof logseq.Assets.makeUrl === 'function') {
    try {
      const url = await logseq.Assets.makeUrl(rawPath);
      const res = await fetch(url);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
      }
    } catch {}
  }

  // 2. Try XMLHttpRequest
  if (inLogseq && logseq.Assets && typeof logseq.Assets.makeUrl === 'function') {
    try {
      const url = await logseq.Assets.makeUrl(rawPath);
      const data = await new Promise<Uint8Array | null>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
          if (xhr.status === 200 || xhr.status === 0) {
            resolve(new Uint8Array(xhr.response));
          } else {
            resolve(null);
          }
        };
        xhr.onerror = () => resolve(null);
        xhr.send();
      });
      if (data && data.length > 0) return data;
    } catch {}
  }

  // 3. Try logseq.caller API
  if (inLogseq && (logseq as any).caller) {
    try {
      const res = await (logseq as any).caller.callAsync('api:call', {
        method: 'read-file',
        args: [rawPath, 'binary'],
      });
      if (res instanceof Uint8Array) return res;
    } catch {}
  }

  return null;
}

async function readLogseqActiveGraph(): Promise<LogseqFile[]> {
  const out: LogseqFile[] = [];
  if (!inLogseq) return out;

  // 1. Scan all pages and journals via Logseq Editor API
  const pages = await logseq.Editor.getAllPages();
  if (Array.isArray(pages)) {
    for (const page of pages) {
      if (!page.name) continue;
      const blocks = await logseq.Editor.getPageBlocksTree(page.name);
      const isJournal = Boolean((page as any)['journal?']);
      const folder = isJournal ? 'journals' : 'pages';
      out.push({
        name: `${page.name}.md`,
        path: `${folder}/${page.name}.md`,
        content: blocksToMd(page.name, blocks),
        type: isJournal ? 'journal' : 'page',
        selected: true,
      });
    }
  }

  // 2. Scan assets via Logseq Assets API (Native Plugin SDK)
  const scannedAssetPaths = new Set<string>();

  if (logseq.Assets && typeof logseq.Assets.listFilesOfCurrentGraph === 'function') {
    try {
      const assetList = await logseq.Assets.listFilesOfCurrentGraph();
      if (Array.isArray(assetList)) {
        for (const item of assetList) {
          try {
            const rawPath = item.path || '';
            const fileName = rawPath.split(/[\\/]/).pop() || 'asset';
            const relPath = `assets/${fileName}`;
            if (scannedAssetPaths.has(relPath)) continue;

            const buf = await fetchLogseqAssetData(rawPath) || await fetchLogseqAssetData(relPath);
            if (buf && buf.length > 0) {
              out.push({
                name: fileName,
                path: relPath,
                content: buf,
                type: 'asset',
                selected: true,
              });
              scannedAssetPaths.add(relPath);
            }
          } catch (e) {
            console.warn('[Assets API] Failed to fetch asset item:', item, e);
          }
        }
      }
    } catch (e) {
      console.warn('[Assets API] listFilesOfCurrentGraph failed:', e);
    }
  }

  // 3. Scan asset links referenced across all markdown pages and journals
  const assetRegex = /(?:\.\.\/)?assets\/([a-zA-Z0-9_\-\.%\+]+)/gi;
  for (const f of out) {
    if (typeof f.content === 'string') {
      let m: RegExpExecArray | null;
      while ((m = assetRegex.exec(f.content)) !== null) {
        const fileName = decodeURIComponent(m[1]).split(/[\\/]/).pop();
        if (!fileName) continue;
        const relPath = `assets/${fileName}`;
        if (scannedAssetPaths.has(relPath)) continue;

        const buf = await fetchLogseqAssetData(relPath) || await fetchLogseqAssetData(`../${relPath}`);
        if (buf && buf.length > 0) {
          out.push({
            name: fileName,
            path: relPath,
            content: buf,
            type: 'asset',
            selected: true,
          });
          scannedAssetPaths.add(relPath);
        }
      }
    }
  }

  // 4. Scan assets via Node fs if available (Logseq Desktop with direct fs access)
  const nodeFs = scanner.getNodeFs();
  if (nodeFs) {
    try {
      const currGraph = await logseq.App.getCurrentGraph();
      if (currGraph?.path) {
        const assetsDir = nodeFs.path.join(currGraph.path, 'assets');
        if (nodeFs.fs.existsSync(assetsDir)) {
          const files = nodeFs.fs.readdirSync(assetsDir);
          for (const fileName of files) {
            const relPath = `assets/${fileName}`;
            if (scannedAssetPaths.has(relPath)) continue;

            const fullP = nodeFs.path.join(assetsDir, fileName);
            const stat = nodeFs.fs.statSync(fullP);
            if (stat.isFile()) {
              const rawBuf = nodeFs.fs.readFileSync(fullP);
              const u8 = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
              out.push({
                name: fileName,
                path: relPath,
                content: u8,
                type: 'asset',
                selected: true,
              });
              scannedAssetPaths.add(relPath);
            }
          }
        }
      }
    } catch (e) {}
  }

  return out;
}

function blocksToMd(name: string, blocks: any[], level = 0): string {
  let r = level === 0 ? `title:: ${name}\n\n` : '';
  if (!blocks) return r;
  for (const b of blocks) {
    r += `${'  '.repeat(level)}- ${b.content || ''}\n`;
    if (b.children?.length) r += blocksToMd(name, b.children, level + 1);
  }
  return r;
}

/* ═══════════════════════════════════════
   DICTIONARY LOOKUP
   ═══════════════════════════════════════ */
async function lookupWord(word: string, context?: string) {
  document.querySelector('.tab-btn[data-tab="dictionary-tab"]')?.dispatchEvent(new Event('click'));
  const inp = document.getElementById('dict-search-input') as HTMLInputElement;
  if (inp) inp.value = word;
  document.getElementById('dict-result-card')?.classList.add('hidden');
  document.getElementById('dict-loading')?.classList.remove('hidden');
  try {
    currentDictResult = await dictionary.lookupWord(word, context);
    renderDictResult(currentDictResult);
  } catch (err: any) {
    showToast(`Lỗi tra từ: ${err.message}`);
  } finally {
    document.getElementById('dict-loading')?.classList.add('hidden');
  }
}

function renderDictResult(r: DictionaryResult) {
  setText('dict-word-title', r.word);
  setText('dict-pos', r.partOfSpeech || 'phrase');
  setText('dict-phonetic', r.phonetic || '');
  setText('dict-translation-val', r.translation);

  const ul = document.getElementById('dict-definitions-list')!;
  ul.innerHTML = '';
  for (const d of r.definitions) {
    const li = document.createElement('li');
    li.textContent = d.definition + (d.example ? ` — "${d.example}"` : '');
    ul.appendChild(li);
  }

  const ctxBox  = document.getElementById('dict-context-box');
  const ctxText = document.getElementById('dict-context-text');
  if (r.contextSentence && ctxText) {
    ctxText.textContent = `"${r.contextSentence}"`;
    ctxBox?.classList.remove('hidden');
  } else { ctxBox?.classList.add('hidden'); }

  const audioBtn = document.getElementById('dict-audio-btn');
  if (audioBtn) {
    audioBtn.classList.remove('hidden');
    audioBtn.onclick = () => playGoogleTTS(r.word);
  }

  document.getElementById('dict-result-card')?.classList.remove('hidden');
}

function openDictionaryTab(blockContent: string) {
  const word = window.getSelection()?.toString().trim() || blockContent.slice(0, 80);
  lookupWord(word, blockContent);
}

/* ═══════════════════════════════════════
   ANKI HIERARCHICAL DECK TREE & UI
   ═══════════════════════════════════════ */
function renderDeckTree() {
  const container = document.getElementById('deck-tree-container');
  if (!container) return;
  container.innerHTML = '';

  const tree = ankiStore.getDeckTree();

  // Root ALL button state
  const allBtn = document.getElementById('deck-node-all');
  if (allBtn) {
    if (currentSelectedDeck === 'ALL') {
      allBtn.classList.add('active');
    } else {
      allBtn.classList.remove('active');
    }
    const allStats = ankiStore.getStats();
    setText('deck-all-count-badge', `${allStats.total}`);
  }

  const renderNode = (node: DeckNode, depth: number = 0): HTMLElement => {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';

    const item = document.createElement('div');
    item.className = `deck-tree-item ${currentSelectedDeck === node.fullPath ? 'active' : ''}`;
    item.style.paddingLeft = `${Math.max(6, depth * 14 + 6)}px`;

    const hasChildren = node.children && node.children.length > 0;
    const isCollapsed = collapsedDeckPaths.has(node.fullPath);

    const left = document.createElement('div');
    left.className = 'deck-item-left';

    if (hasChildren) {
      const toggle = document.createElement('button');
      toggle.className = 'deck-toggle-btn';
      toggle.textContent = isCollapsed ? '▶' : '▼';
      toggle.onclick = (e) => {
        e.stopPropagation();
        if (collapsedDeckPaths.has(node.fullPath)) {
          collapsedDeckPaths.delete(node.fullPath);
        } else {
          collapsedDeckPaths.add(node.fullPath);
        }
        renderDeckTree();
      };
      left.appendChild(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.style.width = '12px';
      spacer.style.display = 'inline-block';
      left.appendChild(spacer);
    }

    const icon = document.createElement('span');
    icon.className = 'deck-icon';
    icon.textContent = hasChildren ? (isCollapsed ? '📁' : '📂') : '📄';
    left.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'deck-name';
    name.textContent = node.name;
    name.title = node.fullPath;
    left.appendChild(name);

    item.appendChild(left);

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '4px';

    if (node.dueToday > 0) {
      const dueBadge = document.createElement('span');
      dueBadge.className = 'badge';
      dueBadge.style.background = '#ef4444';
      dueBadge.style.fontSize = '10px';
      dueBadge.style.padding = '1px 5px';
      dueBadge.textContent = `${node.dueToday}`;
      dueBadge.title = `${node.dueToday} từ cần ôn`;
      right.appendChild(dueBadge);
    }

    const totalBadge = document.createElement('span');
    totalBadge.className = 'badge';
    totalBadge.style.background = 'rgba(255,255,255,0.1)';
    totalBadge.style.fontSize = '10px';
    totalBadge.style.padding = '1px 5px';
    totalBadge.textContent = `${node.total}`;
    right.appendChild(totalBadge);

    item.appendChild(right);

    item.onclick = () => {
      currentSelectedDeck = node.fullPath;
      updateAnkiUI();
    };

    wrapper.appendChild(item);

    if (hasChildren && !isCollapsed) {
      const childrenCont = document.createElement('div');
      childrenCont.className = 'deck-node-children';
      for (const child of node.children) {
        childrenCont.appendChild(renderNode(child, depth + 1));
      }
      wrapper.appendChild(childrenCont);
    }

    return wrapper;
  };

  for (const node of tree) {
    container.appendChild(renderNode(node, 0));
  }
}

function openEditCardModal(card: AnkiCard) {
  const modal = document.getElementById('edit-card-modal');
  if (!modal) return;

  const idInp = document.getElementById('edit-card-id') as HTMLInputElement;
  const wordInp = document.getElementById('edit-card-word') as HTMLInputElement;
  const posInp = document.getElementById('edit-card-pos') as HTMLInputElement;
  const phoInp = document.getElementById('edit-card-phonetic') as HTMLInputElement;
  const transInp = document.getElementById('edit-card-translation') as HTMLTextAreaElement;
  const defInp = document.getElementById('edit-card-definition') as HTMLTextAreaElement;
  const ctxInp = document.getElementById('edit-card-context') as HTMLTextAreaElement;
  const deckInp = document.getElementById('edit-card-deck') as HTMLInputElement;
  const statusSel = document.getElementById('edit-card-status') as HTMLSelectElement;

  if (idInp) idInp.value = card.id;
  if (wordInp) wordInp.value = card.word;
  if (posInp) posInp.value = card.partOfSpeech || '';
  if (phoInp) phoInp.value = card.phonetic || '';
  if (transInp) transInp.value = card.translation || '';
  if (defInp) defInp.value = card.definition || '';
  if (ctxInp) ctxInp.value = card.contextSentence || '';
  if (deckInp) deckInp.value = card.deckPath || 'Inbox';
  if (statusSel) statusSel.value = card.status || 'new';

  modal.classList.remove('hidden');
}

function closeEditCardModal() {
  document.getElementById('edit-card-modal')?.classList.add('hidden');
}

function renderCardList() {
  const list = document.getElementById('anki-cards-list');
  if (!list) return;
  list.innerHTML = '';
  list.className = 'outliner-tree-root';

  const searchVal = ((document.getElementById('card-search-input') as HTMLInputElement)?.value || (document.getElementById('anki-search-input') as HTMLInputElement)?.value || '').toLowerCase().trim();
  const statusVal = (document.getElementById('card-status-filter') as HTMLSelectElement)?.value || (document.getElementById('anki-status-filter') as HTMLSelectElement)?.value || 'all';
  const sortVal = (document.getElementById('anki-sort-select') as HTMLSelectElement)?.value || 'newest';

  const batchBar = document.getElementById('batch-action-bar');
  const countLabel = document.getElementById('selected-cards-count');
  const selectAllCb = document.getElementById('select-all-cards-cb') as HTMLInputElement;

  if (batchBar && countLabel) {
    if (selectedCardIds.size > 0) {
      batchBar.classList.remove('hidden');
      countLabel.textContent = `Đã chọn ${selectedCardIds.size} từ`;
    } else {
      batchBar.classList.add('hidden');
      if (selectAllCb) selectAllCb.checked = false;
    }
  }

  const tree = ankiStore.getDeckTree(currentSelectedDeck);

  if (tree.length === 0) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Chưa có từ vựng hoặc Deck nào. Hãy bôi đen từ trong Logseq để lưu thẻ!</div>';
    return;
  }

  const matchesFilter = (c: AnkiCard) => {
    const matchesSearch = !searchVal || c.word.toLowerCase().includes(searchVal) || c.translation.toLowerCase().includes(searchVal) || (c.deckPath || '').toLowerCase().includes(searchVal);
    let matchesStatus = true;
    if (statusVal === 'due') {
      const today = new Date().toISOString().split('T')[0];
      matchesStatus = c.dueDate <= today || c.status === 'new';
    } else if (statusVal === 'new') {
      matchesStatus = c.status === 'new';
    } else if (statusVal === 'learning') {
      matchesStatus = c.status === 'learning';
    } else if (statusVal === 'mastered') {
      matchesStatus = c.status === 'mastered';
    }
    return matchesSearch && matchesStatus;
  };

  const renderDeckBlock = (node: DeckNode, depth: number = 0): HTMLElement | null => {
    const matchingCards = node.cards.filter(matchesFilter);

    // Apply Sorting
    if (sortVal === 'newest') {
      matchingCards.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    } else if (sortVal === 'az') {
      matchingCards.sort((a, b) => a.word.localeCompare(b.word));
    } else if (sortVal === 'due') {
      matchingCards.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
    } else if (sortVal === 'ease') {
      matchingCards.sort((a, b) => (a.easeFactor || 2.5) - (b.easeFactor || 2.5));
    }

    const renderedChildren: HTMLElement[] = [];
    for (const child of node.children) {
      const el = renderDeckBlock(child, depth + 1);
      if (el) renderedChildren.push(el);
    }

    if ((searchVal || statusVal !== 'all') && matchingCards.length === 0 && renderedChildren.length === 0) {
      return null;
    }

    const block = document.createElement('div');
    block.className = 'outliner-block deck-block';
    const row = document.createElement('div');
    row.className = 'outliner-row deck-row';
    const isCollapsed = collapsedOutlinerNodes.has(node.fullPath);
    const hasChildren = renderedChildren.length > 0 || matchingCards.length > 0;

    if (hasChildren) {
      const foldBtn = document.createElement('button');
      foldBtn.className = 'outliner-fold-btn';
      foldBtn.textContent = isCollapsed ? '▶' : '▼';
      foldBtn.onclick = (e) => {
        e.stopPropagation();
        if (collapsedOutlinerNodes.has(node.fullPath)) {
          collapsedOutlinerNodes.delete(node.fullPath);
        } else {
          collapsedOutlinerNodes.add(node.fullPath);
        }
        renderCardList();
      };
      row.appendChild(foldBtn);
    } else {
      const spacer = document.createElement('span');
      spacer.style.width = '14px';
      spacer.style.display = 'inline-block';
      row.appendChild(spacer);
    }

    const bullet = document.createElement('span');
    bullet.className = 'outliner-bullet';
    bullet.textContent = '●';
    row.appendChild(bullet);

    const title = document.createElement('span');
    title.className = 'deck-title';
    title.innerHTML = `${node.name} <span class="deck-tag-label">#deck</span>`;
    title.title = `Đường dẫn đầy đủ: ${node.fullPath}`;
    row.appendChild(title);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = 'rgba(99,102,241,0.2)';
    badge.style.fontSize = '10px';
    badge.textContent = `${node.total} từ` + (node.dueToday > 0 ? ` • 🔴 ${node.dueToday} cần ôn` : '');
    row.appendChild(badge);

    const deckActions = document.createElement('div');
    deckActions.className = 'deck-row-actions';

    const studyBtn = document.createElement('button');
    studyBtn.className = 'btn btn-primary btn-sm';
    studyBtn.style.padding = '2px 8px';
    studyBtn.style.fontSize = '11px';
    studyBtn.textContent = '🎴 Ôn tập Deck';
    studyBtn.onclick = (e) => {
      e.stopPropagation();
      currentSelectedDeck = node.fullPath;
      currentActiveSubtab = 'study';
      document.getElementById('tab-sub-study-btn')?.click();
      updateAnkiUI();
    };
    deckActions.appendChild(studyBtn);

    const addWordBtn = document.createElement('button');
    addWordBtn.className = 'btn-text';
    addWordBtn.title = 'Thêm từ mới vào Deck này';
    addWordBtn.textContent = '➕ Thêm từ';
    addWordBtn.onclick = (e) => {
      e.stopPropagation();
      const word = prompt(`Nhập từ mới vào Deck [${node.fullPath}]:`);
      if (word && word.trim()) {
        const trans = prompt(`Nhập nghĩa của từ "${word.trim()}":`);
        if (trans && trans.trim()) {
          ankiStore.addCard({
            word: word.trim(),
            translation: trans.trim(),
            deckPath: node.fullPath,
            sourcePage: node.fullPath,
          });
          updateAnkiUI();
          showToast(`✅ Đã thêm từ "${word.trim()}" vào [${node.fullPath}]`);
        }
      }
    };
    deckActions.appendChild(addWordBtn);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-text';
    renameBtn.title = 'Đổi tên Deck';
    renameBtn.textContent = '✏️';
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      const newName = prompt(`Nhập tên mới cho Deck [${node.fullPath}]:`, node.name);
      if (newName && newName.trim() && newName.trim() !== node.name) {
        const parentPath = node.fullPath.includes('/') ? node.fullPath.slice(0, node.fullPath.lastIndexOf('/')) : '';
        const newFullPath = parentPath ? `${parentPath}/${newName.trim()}` : newName.trim();
        ankiStore.renameDeck(node.fullPath, newFullPath);
        if (currentSelectedDeck === node.fullPath) currentSelectedDeck = newFullPath;
        updateAnkiUI();
        showToast(`✏️ Đã đổi tên Deck thành [${newFullPath}]`);
      }
    };
    deckActions.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-text';
    deleteBtn.title = 'Xóa Deck này';
    deleteBtn.style.color = '#ef4444';
    deleteBtn.textContent = '🗑️';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Bạn có chắc muốn xóa Deck [${node.fullPath}]?\n- Các từ vựng bên trong sẽ được chuyển về "Inbox".`)) {
        ankiStore.deleteDeck(node.fullPath, false);
        if (currentSelectedDeck === node.fullPath) currentSelectedDeck = 'ALL';
        updateAnkiUI();
        showToast(`🗑️ Đã xóa Deck [${node.fullPath}], các từ đã chuyển về Inbox!`);
      }
    };
    deckActions.appendChild(deleteBtn);

    row.appendChild(deckActions);
    block.appendChild(row);

    if (hasChildren && !isCollapsed) {
      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'outliner-children';
      for (const childEl of renderedChildren) childrenContainer.appendChild(childEl);

      for (const card of matchingCards) {
        const cardBlock = document.createElement('div');
        cardBlock.className = 'outliner-block word-block';
        const cardRow = document.createElement('div');
        cardRow.className = 'outliner-row word-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.style.accentColor = 'var(--primary)';
        cb.style.cursor = 'pointer';
        cb.style.width = '15px';
        cb.style.height = '15px';
        cb.checked = selectedCardIds.has(card.id);
        cb.onchange = (e) => {
          e.stopPropagation();
          if (cb.checked) {
            selectedCardIds.add(card.id);
          } else {
            selectedCardIds.delete(card.id);
          }
          renderCardList();
        };
        cardRow.appendChild(cb);

        const cardBullet = document.createElement('span');
        cardBullet.className = 'outliner-bullet word-bullet';
        cardBullet.textContent = '○';
        cardRow.appendChild(cardBullet);

        const wordInfo = document.createElement('div');
        wordInfo.style.display = 'flex';
        wordInfo.style.alignItems = 'center';
        wordInfo.style.gap = '6px';
        wordInfo.style.flexWrap = 'wrap';

        const wordTitle = document.createElement('span');
        wordTitle.className = 'outliner-word-title';
        wordTitle.textContent = card.word;
        wordInfo.appendChild(wordTitle);

        if (card.partOfSpeech) {
          const pos = document.createElement('span');
          pos.className = 'outliner-pos';
          pos.textContent = `(${card.partOfSpeech})`;
          wordInfo.appendChild(pos);
        }

        if (card.phonetic) {
          const pho = document.createElement('span');
          pho.className = 'outliner-phonetic';
          pho.textContent = card.phonetic;
          wordInfo.appendChild(pho);
        }

        const statusDot = document.createElement('span');
        statusDot.className = `status-dot ${card.status}`;
        statusDot.textContent = card.status;
        wordInfo.appendChild(statusDot);

        const cardTag = document.createElement('span');
        cardTag.className = 'deck-tag-label';
        cardTag.textContent = '#card';
        wordInfo.appendChild(cardTag);
        cardRow.appendChild(wordInfo);

        const transCol = document.createElement('div');
        transCol.style.marginLeft = 'auto';
        transCol.style.padding = '0 8px';
        const trans = document.createElement('span');
        trans.className = 'outliner-trans';
        trans.textContent = card.translation;
        transCol.appendChild(trans);
        cardRow.appendChild(transCol);

        const wordActions = document.createElement('div');
        wordActions.className = 'word-actions';

        const audioBtn = document.createElement('button');
        audioBtn.className = 'btn-text';
        audioBtn.title = 'Phát âm (Google TTS)';
        audioBtn.textContent = '🔊';
        audioBtn.onclick = (e) => {
          e.stopPropagation();
          playGoogleTTS(card.word);
        };
        wordActions.appendChild(audioBtn);

        const editBtn = document.createElement('button');
        editBtn.className = 'btn-text';
        editBtn.title = 'Chỉnh sửa toàn bộ thông tin từ vựng';
        editBtn.textContent = '✏️';
        editBtn.onclick = (e) => {
          e.stopPropagation();
          openEditCardModal(card);
        };
        wordActions.appendChild(editBtn);

        const deleteCardBtn = document.createElement('button');
        deleteCardBtn.className = 'btn-text';
        deleteCardBtn.title = 'Xóa từ này';
        deleteCardBtn.style.color = '#ef4444';
        deleteCardBtn.textContent = '🗑️';
        deleteCardBtn.onclick = (e) => {
          e.stopPropagation();
          if (confirm(`Bạn có chắc muốn xóa thẻ từ "${card.word}"?`)) {
            ankiStore.deleteCard(card.id);
            selectedCardIds.delete(card.id);
            updateAnkiUI();
            showToast(`🗑️ Đã xóa từ "${card.word}"`);
          }
        };
        wordActions.appendChild(deleteCardBtn);

        cardRow.appendChild(wordActions);
        cardBlock.appendChild(cardRow);

        const subBlock = document.createElement('div');
        subBlock.className = 'word-sub-blocks';
        let hasSub = false;
        if (card.definition && card.definition !== card.translation) {
          const defRow = document.createElement('div');
          defRow.className = 'outliner-sub-row';
          defRow.innerHTML = `<span class="sub-bullet">-</span> <strong>Định nghĩa:</strong> <span>${card.definition}</span>`;
          subBlock.appendChild(defRow);
          hasSub = true;
        }
        if (card.contextSentence) {
          const ctxRow = document.createElement('div');
          ctxRow.className = 'outliner-sub-row';
          ctxRow.innerHTML = `<span class="sub-bullet">-</span> <strong>Ngữ cảnh:</strong> <em>"${card.contextSentence}"</em>`;
          subBlock.appendChild(ctxRow);
          hasSub = true;
        }
        if (hasSub) {
          cardBlock.appendChild(subBlock);
        }
        childrenContainer.appendChild(cardBlock);
      }
      block.appendChild(childrenContainer);
    }
    return block;
  };

  for (const rootNode of tree) {
    const el = renderDeckBlock(rootNode, 0);
    if (el) list.appendChild(el);
  }

  if (list.children.length === 0) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Không có từ vựng nào phù hợp bộ lọc tìm kiếm.</div>';
  }
}

function updateAnkiUI() {
  const isAll = !currentSelectedDeck || currentSelectedDeck === 'ALL';
  const deckName = isAll ? 'Tất cả từ vựng' : currentSelectedDeck;
  const stats = ankiStore.getStats(currentSelectedDeck, true);

  setText('active-deck-breadcrumb', `📂 ${deckName}`);
  setText('active-deck-stats-text', `${stats.total} từ (${stats.newCards} mới, ${stats.mastered} đã thuộc) • 🔴 ${stats.dueToday} cần ôn hôm nay`);
  setText('anki-due-badge', `${stats.dueToday}`);

  // Multi-color Progress Bar updates
  const total = stats.total > 0 ? stats.total : 1;
  const duePct = stats.total > 0 ? (stats.dueToday / total) * 100 : 0;
  const newPct = stats.total > 0 ? (stats.newCards / total) * 100 : 0;
  const learningPct = stats.total > 0 ? (stats.learning / total) * 100 : 0;
  const masteredPct = stats.total > 0 ? (stats.mastered / total) * 100 : 0;

  const pDue = document.getElementById('prog-due');
  const pNew = document.getElementById('prog-new');
  const pLearning = document.getElementById('prog-learning');
  const pMastered = document.getElementById('prog-mastered');
  if (pDue) pDue.style.width = `${duePct}%`;
  if (pNew) pNew.style.width = `${newPct}%`;
  if (pLearning) pLearning.style.width = `${learningPct}%`;
  if (pMastered) pMastered.style.width = `${masteredPct}%`;

  renderDeckTree();

  // Flexible Study Mode Pool (Due SM-2 / Cram / Difficult / New / Mastered)
  const studyPool = ankiStore.getStudyCards(currentSelectedDeck, currentStudyMode, true);
  const progressLabel = document.getElementById('study-progress-count');
  if (progressLabel) {
    progressLabel.textContent = `Thẻ ${studyPool.length > 0 ? 1 : 0} / ${studyPool.length}`;
  }

  if (studyPool.length > 0) {
    currentReviewCard = studyPool[0];
    document.getElementById('anki-player-card')?.classList.remove('hidden');
    document.getElementById('anki-empty-state')?.classList.add('hidden');

    // Render nested outliner hierarchy breadcrumbs on card front
    const hierCont = document.getElementById('card-front-hierarchy');
    if (hierCont) {
      hierCont.innerHTML = '';
      const deckParts = (currentReviewCard.deckPath || 'Inbox').split('/');
      deckParts.forEach((part, idx) => {
        if (idx > 0) {
          const arrow = document.createElement('span');
          arrow.style.opacity = '0.5';
          arrow.textContent = ' ➔ ';
          hierCont.appendChild(arrow);
        }
        const span = document.createElement('span');
        span.className = 'card-outliner-path';
        span.innerHTML = `<span class="outliner-bullet">●</span> ${part}`;
        hierCont.appendChild(span);
      });
    }

    setText('card-front-deck-badge', `📂 ${currentReviewCard.deckPath || 'Inbox'}`);
    setText('card-front-word', currentReviewCard.word);
    setText('card-front-pos', currentReviewCard.partOfSpeech ? `(${currentReviewCard.partOfSpeech})` : '');
    setText('card-front-phonetic', currentReviewCard.phonetic || '');
    setText('card-front-context', currentReviewCard.contextSentence ? `"${currentReviewCard.contextSentence}"` : '');
    setText('card-back-translation', currentReviewCard.translation);
    setText('card-back-definition', currentReviewCard.definition || '');

    document.getElementById('flashcard-back')?.classList.add('hidden');
    document.getElementById('show-answer-btn')?.classList.remove('hidden');
    document.getElementById('sm2-ratings-row')?.classList.add('hidden');

    // Auto TTS on new card
    const autoTtsCb = document.getElementById('anki-auto-tts-cb') as HTMLInputElement;
    if (autoTtsCb && autoTtsCb.checked && currentReviewCard) {
      playGoogleTTS(currentReviewCard.word);
    }
  } else {
    currentReviewCard = null;
    document.getElementById('anki-player-card')?.classList.add('hidden');
    document.getElementById('anki-empty-state')?.classList.remove('hidden');
  }

  // Re-render Card List
  renderCardList();
}

/* ═══════════════════════════════════════
   PROGRESS & LOGGING
   ═══════════════════════════════════════ */
function updateProgressUI(p: ScanProgress) {
  const pct = p.totalFiles > 0 ? Math.round(p.processedFiles / p.totalFiles * 100) : 0;
  const bar = document.getElementById('progress-bar-inner');
  if (bar) bar.style.width = `${pct}%`;
  setText('progress-percent-text', `${pct}%`);
  setText('progress-status-text', p.status === 'translating' ? `📄 ${p.currentFileName}` : p.status);
  setText('stat-files-val',  `${p.processedFiles} / ${p.totalFiles}`);
  setText('stat-blocks-val', `${p.translatedBlocks}`);
}

function appendLog(level: 'info' | 'success' | 'warn' | 'error', text: string) {
  const t = document.getElementById('log-terminal');
  if (!t) return;
  const d = document.createElement('div');
  d.className = `log-line ${level}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  t.appendChild(d);
  t.scrollTop = t.scrollHeight;
}

function showToast(msg: string) {
  if (inLogseq) { logseq.UI.showMsg(msg, 'success'); return; }
  alert(msg);
}

function setText(id: string, val: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ═══════════════════════════════════════
   LOGSEQ BLOCK TEXT HELPERS
   ═══════════════════════════════════════ */

/**
 * Strip Logseq markdown syntax from block content to get readable plain text.
 */
function cleanBlockText(content: string): string {
  return content
    .replace(/\[\[([^\]]+)\]\]/g, '$1')   // [[Page Name]] → Page Name
    .replace(/!\[.*?\]\(.*?\)/g, '')       // remove images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/#[a-zA-Z0-9_\-\/]+/g, '')   // remove tags
    .replace(/^[-*]\s+/, '')               // remove bullet prefix
    .replace(/`[^`]+`/g, '')              // remove inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')        // *italic* → italic
    .trim()
    .slice(0, 3000);                      // Support long paragraphs up to 3000 chars
}

/**
 * Read selected text from the Logseq top-frame DOM synchronously.
 * Works for text selected by the user directly on the Logseq page.
 */
function getTopFrameSelection(): string {
  // Try own window first (works in standalone mode)
  const ownSel = window.getSelection()?.toString().trim() ?? '';
  if (ownSel) return ownSel;

  // Try top frame (Logseq iframe context)
  try {
    const topWin = window.top ?? window;
    const topSel = (topWin as any).getSelection?.()?.toString?.()?.trim?.() ?? '';
    if (topSel) return topSel;
  } catch {}

  // Try reading from all iframes in the top document
  try {
    const topDoc = (window.top ?? window).document;
    for (const iframe of Array.from(topDoc.querySelectorAll('iframe'))) {
      try {
        const iSel = (iframe as HTMLIFrameElement).contentWindow?.getSelection?.()?.toString?.().trim() ?? '';
        if (iSel) return iSel;
      } catch {}
    }
  } catch {}

  return '';
}

/**
 * Get position (x, y) of the current text selection in page coordinates.
 * Falls back to last known mouse position.
 */
function getSelectionPosition(): { x: number; y: number } {
  try {
    // Try top-frame selection rect
    const tryWins = [window, ...(window.top !== window ? [window.top!] : [])];
    for (const w of tryWins) {
      try {
        const sel = (w as any).getSelection?.();
        if (sel && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            return { x: rect.left + rect.width / 2, y: rect.top - 10 };
          }
        }
      } catch {}
    }
  } catch {}
  return { x: lastMouseX, y: lastMouseY };
}

/**
 * Position popup card near the given screen coordinates.
 * Keeps the card within viewport bounds.
 */
function positionPopupNear(x: number, y: number) {
  const overlay = document.getElementById('dict-popup-modal');
  const card = overlay?.querySelector('.popup-card') as HTMLElement | null;
  if (!overlay || !card) return;

  // Overlay covers entire viewport to capture all outside clicks
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.pointerEvents = 'auto';

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(480, vw - 16);
  const cardH = Math.min(card.scrollHeight || 460, vh - 24);

  // Position card absolutely inside full-screen overlay
  card.style.position = 'absolute';
  let left = Math.max(8, Math.min(x - cardW / 2, vw - cardW - 8));
  let top = y - cardH - 12;
  if (top < 8) top = y + 24; // show below if not enough room above
  if (top + cardH > vh - 8) top = Math.max(8, vh - cardH - 8);

  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
}

/**
 * Injects a tiny script into Logseq's main page frame to detect which
 * block element is under the mouse cursor and read its text content.
 */
async function getHoveredBlockContent(): Promise<string> {
  try {
    const result = await logseq.App.queryElementRect('.block-content-wrapper:hover');
    if (result) {
      const block = await logseq.Editor.getCurrentBlock();
      if (block?.content) return cleanBlockText(block.content);
    }
  } catch {}

  try {
    const topWin = window.top ?? window;
    const hovered = (topWin.document as Document).querySelector('.block-content-wrapper:hover .inline-wrap');
    if (hovered) return (hovered.textContent || '').trim().slice(0, 300);
  } catch {}

  return '';
}

/* ═══════════════════════════════════════
   ENTRY — logseq.ready() or standalone
   ═══════════════════════════════════════ */
if (inLogseq) {
  logseq.ready(main).catch(console.error);
} else {
  main().catch(console.error);
}

