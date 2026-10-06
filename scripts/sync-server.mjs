import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3890;

const server = http.createServer((req, res) => {
  // Enable CORS for Logseq plugin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'Logseq Sync Server', version: '1.0.0' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Server is stopping' }));
    setTimeout(() => {
      console.log('[Sync Server] 🛑 Server đã dừng theo yêu cầu từ plugin.');
      process.exit(0);
    }, 200);
    return;
  }

  if (req.method === 'POST' && req.url === '/translate') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { texts, sourceLang, targetLang } = JSON.parse(body);
        if (!texts || !Array.isArray(texts)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'texts must be an array' }));
          return;
        }

        const sl = sourceLang || 'auto';
        const tl = targetLang || 'vi';

        const results = [];
        for (const text of texts) {
          if (!text || !text.trim()) {
            results.push(text);
            continue;
          }

          let translatedText = null;

          // 1. Google translate_a/single
          try {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
            const gRes = await fetch(url);
            if (gRes.ok) {
              const data = await gRes.json();
              if (Array.isArray(data) && Array.isArray(data[0])) {
                translatedText = data[0].map((item) => item[0]).join('');
              }
            }
          } catch (e) {}

          // 2. Fallback clients5
          if (!translatedText) {
            try {
              const cUrl = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
              const cRes = await fetch(cUrl);
              if (cRes.ok) {
                const cData = await cRes.json();
                if (Array.isArray(cData) && Array.isArray(cData[0]) && cData[0][0]) {
                  translatedText = cData[0][0];
                }
              }
            } catch (e) {}
          }

          results.push(translatedText || text);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, results }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        let { targetDir, files, cleanDestination } = JSON.parse(body);

        // Strip surrounding quotes that users may accidentally paste (e.g. "D:\TMHEng")
        if (typeof targetDir === 'string') {
          targetDir = targetDir.trim().replace(/^["']|["']$/g, '').trim();
        }

        if (!targetDir || !files || !Array.isArray(files)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing targetDir or files array' }));
          return;
        }

        console.log(`\n[Sync Server] 🚀 Bắt đầu ghi ${files.length} file vào thư mục: ${targetDir}`);

        // 1. Clean destination folders if requested
        if (cleanDestination !== false && fs.existsSync(targetDir)) {
          const folders = ['pages', 'journals', 'assets', 'logseq'];
          for (const folder of folders) {
            const fPath = path.join(targetDir, folder);
            if (fs.existsSync(fPath)) {
              try {
                fs.rmSync(fPath, { recursive: true, force: true });
                console.log(`[Sync Server] 🧹 Đã làm sạch: ${folder}/`);
              } catch (e) {
                console.warn(`[Sync Server] Không thể xóa ${folder}:`, e.message);
              }
            }
          }
        }

        // 2. Ensure targetDir exists
        fs.mkdirSync(targetDir, { recursive: true });

        // 3. Write each file
        let written = 0;
        for (const file of files) {
          const fullPath = path.join(targetDir, file.path);
          const dir = path.dirname(fullPath);
          fs.mkdirSync(dir, { recursive: true });

          if (file.type === 'asset' || file.isBinary) {
            // Buffer from base64 or raw
            let buffer;
            if (typeof file.content === 'string' && file.isBase64) {
              buffer = Buffer.from(file.content, 'base64');
            } else if (file.content && file.content.data) {
              buffer = Buffer.from(file.content.data);
            } else if (typeof file.content === 'string') {
              buffer = Buffer.from(file.content, 'utf-8');
            } else {
              buffer = Buffer.from(file.content);
            }
            fs.writeFileSync(fullPath, buffer);
          } else {
            const text = typeof file.content === 'string' ? file.content : Buffer.from(file.content).toString('utf-8');
            fs.writeFileSync(fullPath, text, 'utf-8');
          }
          written++;
        }

        console.log(`[Sync Server] ✅ Đã ghi thành công ${written}/${files.length} file vào ổ cứng!`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, writtenCount: written, targetDir }));
      } catch (err) {
        console.error('[Sync Server] ❌ Lỗi khi ghi file:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`=======================================================`);
  console.log(`🌐 Logseq Translator Local Sync Server đang chạy tại:`);
  console.log(`👉 http://127.0.0.1:${PORT}`);
  console.log(`⚡ Plugin Logseq sẽ tự động ghi 100% trực tiếp vào mọi ổ đĩa!`);
  console.log(`=======================================================`);
});
