/**
 * End-to-end diagnostic test:
 * 1. Check sync server health
 * 2. Send a translate request
 * 3. Send a sync/write request with sample translated files to D:\TMHEng
 */
import http from 'http';

const SERVER = '127.0.0.1';
const PORT = 3890;
// CHANGE THIS to your actual dest graph folder
const DEST_DIR = 'D:\\TMHEng';

function post(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      {
        hostname: SERVER, port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode, body: d }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: SERVER, port: PORT, path, method: 'GET' }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('\n══════════════════════════════════════════');
  console.log('  🔍 LOGSEQ TRANSLATOR — DIAGNOSTIC TEST');
  console.log('══════════════════════════════════════════\n');

  // 1. Health check
  console.log('1️⃣  Kiểm tra Sync Server...');
  try {
    const h = await get('/health');
    if (h.status === 200) {
      console.log('   ✅ Sync Server đang chạy:', h.body);
    } else {
      console.log('   ❌ Sync Server trả về status:', h.status);
      return;
    }
  } catch (e) {
    console.log('   ❌ Sync Server KHÔNG chạy:', e.message);
    console.log('   → Hãy chạy: node scripts/sync-server.mjs');
    return;
  }

  // 2. Translation test
  console.log('\n2️⃣  Test dịch thuật qua server...');
  const tResult = await post('/translate', {
    texts: [
      'What is the cerebrum?',
      'The cerebrum is the largest part of the brain.',
      'It consists of the cerebral cortex and subcortical structures.',
    ],
    sourceLang: 'auto',
    targetLang: 'vi',
  });
  if (tResult.body.success) {
    console.log('   ✅ Dịch thành công!');
    tResult.body.results.forEach((r, i) => console.log(`   [${i}] ${r}`));
  } else {
    console.log('   ❌ Dịch lỗi:', tResult.body);
  }

  // 3. Sync/write test to dest folder
  console.log(`\n3️⃣  Test ghi file sang ${DEST_DIR}...`);
  const sResult = await post('/sync', {
    targetDir: DEST_DIR,
    cleanDestination: false,
    files: [
      {
        name: '_diagnostic.md',
        path: 'pages/_diagnostic.md',
        type: 'page',
        content: `title:: Diagnostic Test\n\n- Sync Server đang hoạt động đúng!\n- Timestamp: ${new Date().toISOString()}\n`,
      },
    ],
  });
  if (sResult.body.success) {
    console.log(`   ✅ Ghi file thành công! writtenCount=${sResult.body.writtenCount}`);
    console.log(`   → Kiểm tra file: ${DEST_DIR}\\pages\\_diagnostic.md`);
  } else {
    console.log('   ❌ Ghi file thất bại:', sResult.body);
  }

  console.log('\n══════════════════════════════════════════');
  console.log('  ✔ Diagnostic HOÀN THÀNH');
  console.log('══════════════════════════════════════════\n');
}

run().catch(console.error);
