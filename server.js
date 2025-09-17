// server.js — Express app with live SSE progress via Ookla JSONL + JSON endpoints 
const path = require('path');
const fs = require('fs');

const SPEEDTEST_BIN = process.platform === 'win32'
  ? path.join(__dirname, 'speedtest.exe')
  : path.join(__dirname, 'speedtest');

// Optional: ensure it's executable on Linux (Render)
try {
  if (process.platform !== 'win32') {
    fs.chmodSync(SPEEDTEST_BIN, 0o755);
  }
} catch (e) {
  console.warn('Could not set executable permissions:', e.message);
}

require('dotenv').config();
const express = require('express');
const { spawn, exec } = require('child_process');
const http = require('http');
const fs = require('fs');
const cors = require('cors');
const os = require('os');

const app = express();

const PORT = parseInt(process.env.PORT || '8080', 10);
const LEGACY_PORT = parseInt(process.env.LEGACY_PORT || '3000', 10); // unused on Render
const SERVER_ID = process.env.SERVER_ID || 71582; // e.g., Djezzy Oran
const isWin = process.platform === 'win32';
//const SPEEDTEST_BIN = isWin ? path.join(__dirname, 'speedtest.exe') : path.join(__dirname, 'speedtest');
const FRONTEND_DIR = path.join(__dirname, 'frontend');

// middlewares
app.use(cors());
app.use(express.static(FRONTEND_DIR));

// -------------------------
// Debug endpoints
// -------------------------

// Helper to run a command with limits and return promise
function runCmd(cmd, opts = {}) {
  const { timeout = 10000, maxBuffer = 1024 * 1024 } = opts;
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message, stderr: (stderr || '').toString().slice(0, 2000) });
      } else {
        resolve({ ok: true, out: (stdout || '').toString().slice(0, 20000) });
      }
    });
  });
}

// 1) Check binary presence using which (Unix) or file existence on Win
app.get('/debug/check-binary', async (req, res) => {
  if (isWin) {
    const p = SPEEDTEST_BIN;
    try {
      const exists = fs.existsSync(p);
      return res.json({ ok: exists, path: exists ? p : null, platform: 'win32' });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  }
  const result = await runCmd(`which ${SPEEDTEST_BIN}`);
  if (!result.ok) return res.json({ ok: false, message: 'binary not found', details: result });
  return res.json({ ok: true, path: result.out.trim() });
});

// 2) Speedtest version (if available)
app.get('/debug/speedtest-version', async (req, res) => {
  if (isWin) {
    // Windows: try spawn with --version if file exists
    if (!fs.existsSync(SPEEDTEST_BIN)) return res.json({ ok: false, error: 'binary not present' });
    try {
      const r = await runCmd(`"${SPEEDTEST_BIN}" --version`, { timeout: 5000 });
      return res.json(r);
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  }
  const whichRes = await runCmd(`which ${SPEEDTEST_BIN}`);
  if (!whichRes.ok) return res.json({ ok: false, message: 'binary not found', details: whichRes });
  const pathToBin = whichRes.out.trim();
  const v = await runCmd(`"${pathToBin}" --version`);
  return res.json(v);
});

// 3) List binary file (ls -l) — useful to check permissions and location
app.get('/debug/list-bin', async (req, res) => {
  if (isWin) {
    // On Windows return file info if present
    if (!fs.existsSync(SPEEDTEST_BIN)) return res.json({ ok: false, error: 'binary not present' });
    const s = fs.statSync(SPEEDTEST_BIN);
    return res.json({
      ok: true,
      path: SPEEDTEST_BIN,
      size: s.size,
      mode: s.mode,
      mtime: s.mtime,
    });
  }
  const whichRes = await runCmd(`which ${SPEEDTEST_BIN}`);
  if (!whichRes.ok) return res.json({ ok: false, message: 'binary not found', details: whichRes });
  const pathToBin = whichRes.out.trim();
  const lsRes = await runCmd(`ls -l ${pathToBin}`);
  return res.json(lsRes);
});

// 4) Small safe env dump — only non-secret helpful vars
app.get('/debug/env', (req, res) => {
  const safe = {
    NODE_ENV: process.env.NODE_ENV || null,
    PORT: process.env.PORT || null,
    SERVER_ID: process.env.SERVER_ID || null,
    RENDER: process.env.RENDER || null,
    HOSTNAME: os.hostname(),
    platform: process.platform,
    arch: process.arch,
  };
  res.json({ ok: true, env: safe });
});

// 5) Processes (limited) — ps aux head -n 60
app.get('/debug/ps', async (req, res) => {
  if (isWin) {
    return res.json({ ok: false, message: 'ps not supported on Windows via this endpoint' });
  }
  const ps = await runCmd('ps aux | head -n 60');
  res.json(ps);
});

// -------------------------
// Health & API
// -------------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- One-shot JSON (final result) ----
function runSpeedtestJSON(res) {
  // Build the command string (shell form so we can pass flags)
  const cmd = `"${SPEEDTEST_BIN}" --accept-license --accept-gdpr -s ${SERVER_ID} -f json`;

  // Try exec — if the binary is missing exec will call the callback with an error.
  exec(cmd, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
    if (err) {
      // Helpful error for missing binary (ENOENT) or other failures
      if (err.code === 'ENOENT' || /not found|No such file|cannot find/i.test(err.message + (stderr || ''))) {
        return res.status(500).json({ error: 'speedtest binary not found on server. Deploy with the binary or use a Docker image that includes it.' });
      }
      return res.status(500).json({ error: err.message, stderr });
    }
    try {
      res.json(JSON.parse(stdout));
    } catch (parseErr) {
      res.status(500).json({ error: 'Parse error', parseError: parseErr.message, sample: stdout?.slice(0, 2000) || '' });
    }
  });
}

app.get('/api/speedtest', (req, res) => runSpeedtestJSON(res));
app.get('/speedtest', (req, res) => runSpeedtestJSON(res));

// ---- Live streaming via Server-Sent Events (JSONL from Ookla) ----
app.get('/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* ignore */ }
  };

  // Helper to finish and cleanup
  const finish = (child) => {
    clearInterval(keepAlive);
    try { if (child && !child.killed) child.kill('SIGKILL'); } catch (e) {}
    try { res.end(); } catch (e) {}
  };

  // Cross-platform check for binary:
  if (isWin) {
    // On Windows check file exists
    if (!fs.existsSync(SPEEDTEST_BIN)) {
      send({ type: 'error', message: 'speedtest binary not found on server. Live test unavailable.' });
      finish();
      return;
    }
    // proceed to spawn...
    spawnAndStream();
    return;
  }

  // On Unix-like, use `which` to check PATH (async)
  exec(`which ${SPEEDTEST_BIN}`, (whichErr, stdout) => {
    if (whichErr || !stdout || !stdout.trim()) {
      send({ type: 'error', message: 'speedtest binary not found on server. Live test unavailable.' });
      finish();
      return;
    }
    // binary exists in PATH — spawn
    spawnAndStream();
  });

  // spawn & streaming logic in a function so we only call it when binary is present
  function spawnAndStream() {
    const args = ['--accept-license', '--accept-gdpr', '-s', String(SERVER_ID), '-f', 'jsonl'];
    const child = spawn(SPEEDTEST_BIN, args, { windowsHide: true });

    let stdoutBuf = '';
    let inUploadPhase = false;
    let lastDownloadMbps = null;
    let lastUploadMbps = null;

    // lifecycle logs for Render (helpful)
    console.log('[SSE] spawned speedtest pid=', child.pid);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }

        if (obj.type === 'download' && obj.download?.bandwidth != null && !inUploadPhase) {
          const mbps = (obj.download.bandwidth * 8) / 1e6;
          lastDownloadMbps = mbps;
          send({ type: 'progress', phase: 'download', mbps, t: Date.now() });
          continue;
        }

        if (obj.type === 'upload' && obj.upload?.bandwidth != null) {
          inUploadPhase = true;
          lastUploadMbps = (obj.upload.bandwidth * 8) / 1e6;
          continue;
        }

        if (obj.type === 'result') {
          const downMbps = obj.download?.bandwidth ? (obj.download.bandwidth * 8) / 1e6 : lastDownloadMbps ?? null;
          const upMbps   = obj.upload?.bandwidth   ? (obj.upload.bandwidth   * 8) / 1e6 : lastUploadMbps   ?? null;
          send({ type: 'final', downMbps, upMbps, json: obj, t: Date.now() });
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => {
      console.error('[SSE] speedtest stderr:', s.toString().slice(0,1000));
    });

    child.on('close', (code, signal) => {
      console.log(`[SSE] child closed. code=${code} signal=${signal}`);
      finish(child);
    });

    child.on('error', (e) => {
      console.error('[SSE] spawn error:', e && e.stack ? e.stack : e);
      send({ type: 'error', message: e && e.message ? e.message : String(e) });
      finish(child);
    });

    req.on('close', () => {
      console.log('[SSE] client closed connection');
      send({ type: 'aborted' });
      finish(child);
    });

    // initial event
    send({ type: 'start', serverId: SERVER_ID, t: Date.now() });
  }
});

// ---- Optional legacy JSON on separate port ----
// ---- Legacy JSON route (served on the same port for compatibility) ----
app.get('/legacy/speedtest', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  return runSpeedtestJSON(res);
});

// Start single HTTP server (Render attaches public domain)
http.createServer(app).listen(PORT, () => {
  console.log(`Frontend    : http://localhost:${PORT}/`);
  console.log(`Live SSE    : http://localhost:${PORT}/live`);
  console.log(`JSON (new)  : http://localhost:${PORT}/api/speedtest`);
  console.log(`JSON (alias): http://localhost:${PORT}/speedtest`);
  console.log(`Legacy JSON : http://localhost:${PORT}/legacy/speedtest`);
});
