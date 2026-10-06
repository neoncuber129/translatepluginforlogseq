import { LogseqMarkdownParser, ParseOptions } from './markdownParser';
import { TranslationService } from './translator';
import { AnkiStore } from './ankiStore';
import { LanguageVerifierService, VerificationResult } from './languageVerifier';

export interface ScanProgress {
  status: 'idle' | 'scanning' | 'translating' | 'completed' | 'paused' | 'error';
  totalFiles: number;
  processedFiles: number;
  currentFileName: string;
  translatedBlocks: number;
  errorMessage?: string;
  startTime?: number;
}

export type LogListener = (msg: { level: 'info' | 'success' | 'warn' | 'error'; text: string }) => void;

export interface LogseqFile {
  name: string;
  path: string; // e.g. "pages/index.md", "journals/2026_08_13.md", "assets/photo.png", "logseq/config.edn"
  content: string | Uint8Array;
  type: 'page' | 'journal' | 'asset' | 'config';
  selected?: boolean; // Whether checked by user in UI preview checklist
}

export class GraphScannerService {
  private parser: LogseqMarkdownParser;
  private translator: TranslationService;
  private ankiStore: AnkiStore;
  private verifier: LanguageVerifierService;

  private isPaused: boolean = false;
  private isCancelled: boolean = false;

  public lastVerificationResult: VerificationResult | null = null;

  constructor(translator: TranslationService, parser: LogseqMarkdownParser, ankiStore: AnkiStore) {
    this.translator = translator;
    this.parser = parser;
    this.ankiStore = ankiStore;
    this.verifier = new LanguageVerifierService();
  }

  public pause() {
    this.isPaused = true;
  }

  public resume() {
    this.isPaused = false;
  }

  public cancel() {
    this.isCancelled = true;
  }

  /**
   * Main Graph Translation & Export Process
   */
  public async translateGraphFiles(
    sourceFiles: LogseqFile[],
    parseOptions: ParseOptions,
    onProgress: (progress: ScanProgress) => void,
    onLog: LogListener,
    targetLang: string = 'vi'
  ): Promise<LogseqFile[]> {
    this.isPaused = false;
    this.isCancelled = false;

    const activeFiles = sourceFiles.filter((f) => f.selected !== false);
    const totalFiles = activeFiles.length;
    let processedFiles = 0;
    let translatedBlocks = 0;
    const outputFiles: LogseqFile[] = [];

    this.translator.updateOptions({ targetLang });
    onLog({ level: 'info', text: `🚀 Bắt đầu dịch Graph sang ngôn ngữ [${targetLang.toUpperCase()}] (${totalFiles} file được chọn)...` });

    // Step 0: Auto-detect source language from graph content
    const detectedLang = await this.detectSourceLanguage(activeFiles);
    if (detectedLang && detectedLang !== 'auto' && detectedLang !== targetLang) {
      this.translator.updateOptions({ sourceLang: detectedLang, targetLang });
      onLog({ level: 'info', text: `🌐 Tự động phát hiện ngôn ngữ nguồn: ${detectedLang.toUpperCase()} ➔ Đích: ${targetLang.toUpperCase()}` });
    } else {
      this.translator.updateOptions({ sourceLang: 'auto', targetLang });
    }

    // Step 1: Pre-pass to build Page Title Mapping for ALL pages in source graph
    if (parseOptions.translatePageLinks) {
      onLog({ level: 'info', text: '🔍 Khởi tạo bản đồ liên kết các trang (Page Title Mapping)...' });
      for (const file of activeFiles) {
        if (file.type === 'page' && typeof file.content === 'string') {
          let origTitle = '';
          const match = file.content.match(/^title::\s*(.*)$/m);
          if (match && match[1]) {
            origTitle = match[1].trim();
          } else {
            const cleanName = file.name.replace(/\.(md|org)$/i, '');
            origTitle = cleanName.replace(/___/g, ' / ').replace(/_/g, ' ');
          }

          if (origTitle && !this.parser.getPageMapping().has(origTitle)) {
            const translatedTitle = await this.translator.translateText(origTitle);
            this.parser.getPageMapping().set(origTitle, translatedTitle);
            this.parser.getPageMapping().set(origTitle.toLowerCase(), translatedTitle);

            const fileBase = file.name.replace(/\.(md|org)$/i, '');
            this.parser.getPageMapping().set(fileBase, translatedTitle);
            this.parser.getPageMapping().set(fileBase.toLowerCase(), translatedTitle);
          }
        }
      }
    }

    // Step 2: Translate files line by line or copy config/assets
    for (const file of activeFiles) {
      if (this.isCancelled) {
        onLog({ level: 'warn', text: '🛑 Đã hủy quá trình dịch Graph!' });
        break;
      }

      while (this.isPaused) {
        await new Promise((r) => setTimeout(r, 500));
        if (this.isCancelled) break;
      }

      onProgress({
        status: 'translating',
        totalFiles,
        processedFiles,
        currentFileName: file.path,
        translatedBlocks,
        startTime: Date.now(),
      });

      if (file.type === 'asset' || file.type === 'config') {
        outputFiles.push({ ...file });
        processedFiles++;
        onLog({ level: 'info', text: `📋 Bảo lưu file nguyên bản (asset/cấu hình): ${file.path}` });
        continue;
      }

      try {
        onLog({ level: 'info', text: `📄 Đang dịch: ${file.path}` });
        const contentStr = typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content);
        let translatedContent = await this.parser.translateDocument(contentStr, parseOptions);

        let destPath = file.path;
        if (file.type === 'page') {
          const fileBase = file.name.replace(/\.(md|org)$/i, '');
          let origTitle = fileBase;
          const match = contentStr.match(/^title::\s*(.*)$/m);
          if (match && match[1]) origTitle = match[1].trim();

          const mappedTitle = this.parser.getPageMapping().get(origTitle) || this.parser.getPageMapping().get(fileBase);
          if (mappedTitle) {
            const subDir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : 'pages';
            destPath = `${subDir}/${this.sanitizeFilename(mappedTitle)}.md`;

            // Ensure title:: header is present so Logseq recognizes and auto-creates page
            if (!translatedContent.includes('title::')) {
              translatedContent = `title:: ${mappedTitle}\n\n${translatedContent}`;
            }
          }
        }

        const outputFile: LogseqFile = {
          name: destPath.split('/').pop() || file.name,
          path: destPath,
          content: translatedContent,
          type: file.type,
        };

        outputFiles.push(outputFile);

        translatedBlocks += contentStr.split(/\r?\n/).filter((l) => l.trim()).length;
        processedFiles++;
        onLog({ level: 'success', text: `✅ Đã dịch xong: ${file.path} ➔ ${destPath}` });
      } catch (err: any) {
        onLog({ level: 'error', text: `❌ Lỗi file ${file.path}: ${err.message}` });
        outputFiles.push({ ...file });
        processedFiles++;
      }
    }

    // Step 3: Append Anki Vocabulary Deck page if flashcards exist
    const ankiCardsContent = this.ankiStore.exportToLogseqMarkdown();
    if (ankiCardsContent) {
      const vocabFile: LogseqFile = {
        name: 'Vocabulary Deck.md',
        path: 'pages/Vocabulary Deck.md',
        content: ankiCardsContent,
        type: 'page',
      };
      outputFiles.push(vocabFile);
      onLog({ level: 'success', text: '🎴 Đã bổ sung trang thẻ nhớ vựng Anki: pages/Vocabulary Deck.md' });
    }

    // Step 4: Validate translation language before concluding
    if (!this.isCancelled && outputFiles.length > 0) {
      this.lastVerificationResult = await this.verifier.verifyTranslationLanguage(
        outputFiles,
        activeFiles,
        targetLang,
        onLog
      );
    }

    onProgress({
      status: this.isCancelled ? 'idle' : 'completed',
      totalFiles,
      processedFiles,
      currentFileName: '',
      translatedBlocks,
    });

    onLog({ level: 'success', text: `🎉 HOÀN THÀNH XỬ LÝ GRAPH! ${outputFiles.length} file đã sẵn sàng xuất gói .zip.` });

    return outputFiles;
  }

  /**
   * Syncs files directly to disk via the local companion sync server (http://127.0.0.1:3890).
   * 100% reliable, zero sandbox limitations on Windows/Mac/Linux.
   */
  public async syncViaLocalSyncServer(destDir: string, files: LogseqFile[], onLog: LogListener): Promise<boolean> {
    try {
      const healthController = new AbortController();
      const healthTimer = setTimeout(() => healthController.abort(), 600);
      const healthRes = await fetch('http://127.0.0.1:3890/health', { signal: healthController.signal });
      clearTimeout(healthTimer);

      if (!healthRes.ok) return false;

      onLog({ level: 'info', text: '⚡ Phát hiện Local Sync Server đang chạy trên cổng 3890! Tiến hành ghi trực tiếp vào ổ đĩa...' });

      // Prepare files payload (convert Uint8Array to base64 for binary assets)
      const payloadFiles = files.map((f) => {
        if (f.type === 'asset' || f.content instanceof Uint8Array) {
          let binary = '';
          const bytes = f.content instanceof Uint8Array ? f.content : new Uint8Array(f.content as any);
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          return {
            name: f.name,
            path: f.path,
            type: f.type,
            isBinary: true,
            isBase64: true,
            content: btoa(binary),
          };
        }
        return {
          name: f.name,
          path: f.path,
          type: f.type,
          isBinary: false,
          content: typeof f.content === 'string' ? f.content : new TextDecoder().decode(f.content),
        };
      });

      const syncRes = await fetch('http://127.0.0.1:3890/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir: destDir,
          files: payloadFiles,
          cleanDestination: true,
        }),
      });

      if (!syncRes.ok) return false;
      const data = await syncRes.json();
      if (data.success) {
        onLog({ level: 'success', text: `🚀 [Local Sync Server] Đã ghi trực tiếp THÀNH CÔNG ${data.writtenCount}/${files.length} file vào "${destDir}"!` });
        return true;
      }
    } catch (e) {
      // Local sync server not running, continue with other methods
    }
    return false;
  }

  public async writeSingleFileToDisk(destTarget: any, file: LogseqFile, onLog: LogListener): Promise<boolean> {
    const nodeFs = this.getNodeFs();

    // Method A: Node.js fs (Logseq Desktop app)
    if (nodeFs && typeof destTarget === 'string' && destTarget.length > 2) {
      try {
        const fullPath = nodeFs.path.join(destTarget, file.path);
        const dirName = nodeFs.path.dirname(fullPath);
        nodeFs.fs.mkdirSync(dirName, { recursive: true });

        if (file.type === 'asset') {
          let buf = file.content;
          try {
            const gBuf = (globalThis as any).Buffer || (window as any).Buffer;
            if (gBuf && !(buf instanceof gBuf)) {
              buf = gBuf.from(buf);
            }
          } catch (e) {}
          nodeFs.fs.writeFileSync(fullPath, buf);
        } else {
          nodeFs.fs.writeFileSync(fullPath, file.content, 'utf-8');
        }
        return true;
      } catch (err: any) {
        onLog({ level: 'error', text: `❌ Lỗi Node fs (${file.path}): ${err.message}` });
        return false;
      }
    }

    // Method B: FileSystemDirectoryHandle (HTML5 API)
    if (destTarget && typeof destTarget === 'object' && 'getDirectoryHandle' in destTarget) {
      try {
        const cleanRel = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
        const parts = cleanRel.split('/').filter(Boolean);
        let curr = destTarget;
        for (let i = 0; i < parts.length - 1; i++) {
          curr = await curr.getDirectoryHandle(parts[i], { create: true });
        }
        const fileName = parts[parts.length - 1];
        const fileHandle = await curr.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        
        if (file.type === 'asset' && typeof file.content !== 'string') {
          // Write binary data directly (Uint8Array / ArrayBuffer)
          const data = file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content as any);
          await writable.write(data);
        } else {
          await writable.write(file.content as string);
        }
        
        await writable.close();
        return true;
      } catch (err: any) {
        onLog({ level: 'error', text: `❌ Lỗi ghi file ${file.path}: ${err.message}` });
        return false;
      }
    }

    return false;
  }

  public async syncAssetsDirectoryDirectly(srcDir: string, destDir: string, onLog: LogListener): Promise<void> {
    const nodeFs = this.getNodeFs();
    if (!nodeFs || !srcDir || !destDir) return;

    try {
      let cleanSrc = srcDir.replace(/^[📌📁🎯]\s*/, '').replace(/^Path:\s*/, '').replace(/^Active Graph:\s*/, '').replace(/\(\d+\s*files?\)/gi, '').trim();
      let cleanDest = destDir.replace(/^[📌📁🎯]\s*/, '').replace(/^Path:\s*/, '').replace(/^Active Graph:\s*/, '').replace(/\(\d+\s*files?\)/gi, '').trim();

      // If in Logseq, resolve actual path if cleanSrc or cleanDest is "Active Graph" or invalid
      if (typeof (window as any).logseq !== 'undefined') {
        const logseqObj = (window as any).logseq;
        if (!cleanSrc || srcDir.includes('Active Graph') || !nodeFs.fs.existsSync(cleanSrc)) {
          try {
            const curr = await logseqObj.App.getCurrentGraph();
            if (curr?.path) cleanSrc = curr.path;
          } catch {}
        }
        if (!cleanDest || destDir.includes('Active Graph') || !nodeFs.fs.existsSync(cleanDest)) {
          try {
            const curr = await logseqObj.App.getCurrentGraph();
            if (curr?.path) cleanDest = curr.path;
          } catch {}
        }
      }

      if (!cleanSrc || !nodeFs.fs.existsSync(cleanSrc)) return;

      const srcAssets = nodeFs.path.join(cleanSrc, 'assets');
      const destAssets = nodeFs.path.join(cleanDest, 'assets');

      if (nodeFs.fs.existsSync(srcAssets)) {
        nodeFs.fs.mkdirSync(destAssets, { recursive: true });

        const copyRecursive = (from: string, to: string) => {
          const entries = nodeFs.fs.readdirSync(from, { withFileTypes: true });
          for (const entry of entries) {
            const srcP = nodeFs.path.join(from, entry.name);
            const destP = nodeFs.path.join(to, entry.name);

            if (entry.isDirectory()) {
              nodeFs.fs.mkdirSync(destP, { recursive: true });
              copyRecursive(srcP, destP);
            } else if (entry.isFile()) {
              nodeFs.fs.copyFileSync(srcP, destP);
            }
          }
        };

        copyRecursive(srcAssets, destAssets);
        onLog({ level: 'success', text: '🖼️ Đã sao chép 1:1 trực tiếp toàn bộ file ảnh/PNG từ Nguồn sang Đích!' });
      } else {
        onLog({ level: 'info', text: `ℹ️ Graph nguồn không có thư mục assets, bỏ qua sao chép ảnh.` });
      }
    } catch (err: any) {
      onLog({ level: 'warn', text: `⚠️ Không thể sao chép trực tiếp thư mục assets: ${err.message}` });
    }
  }

  /**
   * Cleans the destination graph folders (pages, journals, assets, logseq, root files) before syncing to ensure 100% clean mirror.
   */
  public async cleanDestinationTargetFolders(destTarget: any, onLog: LogListener): Promise<void> {
    const nodeFs = this.getNodeFs();

    // Method A: Node.js fs (Logseq Desktop)
    if (nodeFs && typeof destTarget === 'string' && destTarget.length > 2) {
      try {
        let cleanDest = destTarget
          .replace(/^[📌📁🎯]\s*/, '')
          .replace(/^Path:\s*/, '')
          .replace(/^Active Graph:\s*/, '')
          .replace(/\(\d+\s*files?\)/gi, '')
          .trim();

        // If in Logseq, resolve actual path if cleanDest is "Active Graph" or invalid
        if (typeof (window as any).logseq !== 'undefined' && (!cleanDest || destTarget.includes('Active Graph') || !nodeFs.fs.existsSync(cleanDest))) {
          try {
            const curr = await (window as any).logseq.App.getCurrentGraph();
            if (curr?.path) cleanDest = curr.path;
          } catch {}
        }

        if (nodeFs.fs.existsSync(cleanDest)) {
          const foldersToWipe = ['pages', 'journals', 'assets', 'logseq'];
          for (const folder of foldersToWipe) {
            const targetDir = nodeFs.path.join(cleanDest, folder);
            if (nodeFs.fs.existsSync(targetDir)) {
              try {
                if (typeof nodeFs.fs.rmSync === 'function') {
                  nodeFs.fs.rmSync(targetDir, { recursive: true, force: true });
                } else {
                  const wipeDir = (d: string) => {
                    const entries = nodeFs.fs.readdirSync(d, { withFileTypes: true });
                    for (const e of entries) {
                      const p = nodeFs.path.join(d, e.name);
                      if (e.isDirectory()) wipeDir(p);
                      else nodeFs.fs.unlinkSync(p);
                    }
                    nodeFs.fs.rmdirSync(d);
                  };
                  wipeDir(targetDir);
                }
              } catch (e) {}
            }
            nodeFs.fs.mkdirSync(targetDir, { recursive: true });
            onLog({ level: 'info', text: `🧹 Đã xóa trắng hoàn toàn thư mục đích: ${folder}/` });
          }

          // Clean root markdown files in destination
          try {
            const rootEntries = nodeFs.fs.readdirSync(cleanDest, { withFileTypes: true });
            for (const entry of rootEntries) {
              if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.org'))) {
                nodeFs.fs.unlinkSync(nodeFs.path.join(cleanDest, entry.name));
              }
            }
          } catch (e) {}
        }
      } catch (err: any) {
        onLog({ level: 'warn', text: `⚠️ Lỗi khi dọn dẹp thư mục Graph đích: ${err.message}` });
      }
      return;
    }

    // Method B: FileSystemDirectoryHandle (HTML5 API)
    if (destTarget && typeof destTarget === 'object' && 'getDirectoryHandle' in destTarget) {
      try {
        const foldersToClean = ['pages', 'journals', 'assets', 'logseq'];
        for (const folderName of foldersToClean) {
          try {
            const subDir = await destTarget.getDirectoryHandle(folderName, { create: false });
            for await (const entry of subDir.values()) {
              if (entry.kind === 'file') {
                await subDir.removeEntry(entry.name);
              } else if (entry.kind === 'directory') {
                await subDir.removeEntry(entry.name, { recursive: true });
              }
            }
            onLog({ level: 'info', text: `🧹 Đã xóa sạch file cũ trong: ${folderName}/` });
          } catch (e) {
            // Folder does not exist yet or empty, continue
          }
        }
      } catch (err: any) {
        onLog({ level: 'warn', text: `⚠️ Lỗi khi dọn dẹp thư mục Graph đích: ${err.message}` });
      }
    }
  }

  public getNodeFs(): { fs: any; path: any; child_process?: any } | null {
    try {
      const candidates = [
        (window as any).require,
        (window.parent as any)?.require,
        (top as any)?.require,
        (globalThis as any).require,
        (window as any).process?.mainModule?.require,
        (window.parent as any)?.process?.mainModule?.require,
      ];
      for (const req of candidates) {
        if (typeof req === 'function') {
          try {
            const fs = req('fs');
            const path = req('path');
            let child_process = null;
            try { child_process = req('child_process'); } catch {}
            if (fs && path && typeof fs.writeFileSync === 'function') {
              return { fs, path, child_process };
            }
          } catch {}
        }
      }
    } catch {}
    return null;
  }

  /**
   * Detects the source language of the graph by sampling text from a few pages
   * and asking Google Translate's language detection endpoint.
   */
  private async detectSourceLanguage(files: LogseqFile[]): Promise<string> {
    // Sample up to 3 markdown files, take the first 200 chars of plain text each
    const sample = files
      .filter((f) => (f.type === 'page' || f.type === 'journal') && typeof f.content === 'string')
      .slice(0, 3)
      .map((f) => {
        const text = (f.content as string)
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('::') && !l.startsWith('---') && !l.startsWith('#'))
          .map((l) => l.replace(/^[-*]\s*/, '').replace(/\[\[[^\]]+\]\]/g, '').trim())
          .filter((l) => l.length > 5)
          .slice(0, 6)
          .join(' ');
        return text.slice(0, 200);
      })
      .join(' ')
      .slice(0, 400);

    if (!sample.trim()) return 'auto';

    try {
      // Use Google Translate detect via the same free endpoint
      const encoded = encodeURIComponent(sample);
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encoded}`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      if (!res.ok) return 'auto';
      const data = await res.json();
      // Response[2] is the detected source language code
      const detected = data?.[2] as string;
      return detected || 'auto';
    } catch {
      return 'auto';
    }
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[\/\\?%*:|"<>]/g, '_').trim();
  }
}
