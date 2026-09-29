#!/usr/bin/env node
/**
 * 梗图档案馆 · 本地服务
 *   静态站点托管 + Replicate 生图代理（零依赖，Node 18+）
 *
 *   node server.mjs        然后打开 http://127.0.0.1:8788
 *
 * 为什么需要这一层：
 *   Replicate 的 API 不返回 CORS 头，浏览器无法直连（已验证：
 *   页面里 fetch 会直接 TypeError: Failed to fetch）。所以密钥必须留在
 *   服务端，前端只能调本机的 /api/*。这也顺带让密钥不出现在页面源码里。
 */
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, normalize, sep } from 'node:path';

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.PORT || 8788);
const HOST = '127.0.0.1';
const REPLICATE = 'https://api.replicate.com/v1';
const GEN_DIR = join(ROOT, 'generated');

/* ---------- .env（零依赖解析） ---------- */
(() => {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
})();

const TOKEN = process.env.REPLICATE_API_TOKEN || '';
const MODEL = process.env.REPLICATE_MODEL || 'black-forest-labs/flux-schnell';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
};

const readBody = (req, limit = 64 * 1024) => new Promise((ok, no) => {
  let n = 0, buf = '';
  req.on('data', c => {
    n += c.length;
    if (n > limit) { no(new Error('请求体过大')); req.destroy(); return; }
    buf += c;
  });
  req.on('end', () => ok(buf));
  req.on('error', no);
});

/** 带超时地调 Replicate */
async function rp(path, init = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(REPLICATE + path, {
      ...init,
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
  } finally {
    clearTimeout(t);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- GET /api/status ---------- */
async function apiStatus(res) {
  if (!TOKEN) {
    return sendJson(res, 200, { ai: false, reason: 'notoken', message: '.env 里没有 REPLICATE_API_TOKEN' });
  }
  try {
    const r = await rp('/account', {}, 12000);
    if (r.status === 401) return sendJson(res, 200, { ai: false, reason: 'badtoken', message: 'token 无效或已失效' });
    if (!r.ok) return sendJson(res, 200, { ai: false, reason: 'http' + r.status, message: 'Replicate 返回 ' + r.status });
    const a = await r.json();
    sendJson(res, 200, { ai: true, model: MODEL, account: a.username });
  } catch (e) {
    sendJson(res, 200, { ai: false, reason: 'network', message: '连不上 Replicate：' + (e.message || e) });
  }
}

/* ---------- POST /api/generate ---------- */
async function apiGenerate(req, res) {
  if (!TOKEN) return sendJson(res, 500, { ok: false, error: '.env 里没有配置 REPLICATE_API_TOKEN' });

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }

  const prompt = String(body.prompt || '').trim();
  if (!prompt) return sendJson(res, 400, { ok: false, error: 'prompt 不能为空' });
  if (prompt.length > 1500) return sendJson(res, 400, { ok: false, error: 'prompt 太长（上限 1500 字）' });

  const ALLOWED_AR = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21'];
  const aspect_ratio = ALLOWED_AR.includes(body.aspect_ratio) ? body.aspect_ratio : '16:9';

  const t0 = Date.now();
  try {
    const cr = await rp(`/models/${MODEL}/predictions`, {
      method: 'POST',
      body: JSON.stringify({ input: { prompt, aspect_ratio, output_format: 'png' } })
    }, 30000);

    let pred = await cr.json().catch(() => ({}));
    if (!cr.ok) {
      const msg = pred?.detail || pred?.error || `Replicate 创建任务失败（${cr.status}）`;
      return sendJson(res, 502, { ok: false, error: msg });
    }

    // 轮询直到出结果
    const deadline = Date.now() + 150000;
    while (pred.status === 'starting' || pred.status === 'processing') {
      if (Date.now() > deadline) return sendJson(res, 504, { ok: false, error: '生成超时（150 秒）' });
      await sleep(1200);
      const pr = await rp(`/predictions/${pred.id}`, {}, 20000);
      pred = await pr.json();
    }
    if (pred.status !== 'succeeded') {
      return sendJson(res, 502, { ok: false, error: pred.error || `生成未成功：${pred.status}` });
    }

    const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!out) return sendJson(res, 502, { ok: false, error: 'Replicate 没有返回图片' });

    // 落盘：replicate.delivery 的链接约 1 小时后失效，存下来才能长期用
    let local = null;
    try {
      const ir = await fetch(out, { signal: AbortSignal.timeout(45000) });
      if (ir.ok) {
        await mkdir(GEN_DIR, { recursive: true });
        const name = new Date().toISOString().replace(/[:.]/g, '-') + '.png';
        await writeFile(join(GEN_DIR, name), Buffer.from(await ir.arrayBuffer()));
        local = '/generated/' + name;
      }
    } catch { /* 落盘失败就用远程链接 */ }

    sendJson(res, 200, {
      ok: true,
      image: local || out,
      saved: !!local,
      model: MODEL,
      ms: Date.now() - t0
    });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: String(e.message || e) });
  }
}

/* ---------- 静态文件 ---------- */
// 不该被当成静态资源拿走的文件
const DENY_FILES = new Set(['server.mjs', 'package.json', 'package-lock.json']);

async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = normalize(join(ROOT, rel));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  // 挡住 .env / .git 这类点文件，以及服务端自身源码
  const base = full === ROOT ? '' : full.slice(ROOT.length + 1);
  const segs = base.split(sep);
  if (segs.some(seg => seg.startsWith('.')) || DENY_FILES.has(segs[segs.length - 1])) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  try {
    const s = await stat(full);
    if (!s.isFile()) throw new Error('not a file');
    const buf = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ---------- 路由 ---------- */
const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);

  if (pathname === '/api/status' && req.method === 'GET') return apiStatus(res);
  if (pathname === '/api/generate' && req.method === 'POST') return apiGenerate(req, res);
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown api' });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  return serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  梗图档案馆  →  http://' + HOST + ':' + PORT);
  console.log('  AI 生图     →  ' + (TOKEN ? '已启用 · ' + MODEL : '未配置（.env 缺 REPLICATE_API_TOKEN）'));
  console.log('  提示：图片生成后会存到 ./generated/，该目录已加入 .gitignore');
  console.log('');
});
