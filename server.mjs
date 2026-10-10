// MiMo 语音克隆 · 独立小工具（零依赖，只用 Node 自带模块）
//
// 它做的事：把一段参考音频（mp3/wav）+ 一句文字，交给小米 MiMo 的
// `mimo-v2.5-tts-voiceclone` 模型，克隆出这个音色的语音，存到 output/ 下并可试听。
//
// 为什么这么写（都是在 QQ Agent 的技能里实测踩出来的）：
//   · audio.voice 必须是 **DataURL**（data:audio/mpeg;base64,…）—— 传裸 base64 会被
//     服务端 400 拒掉：`audio.voice must be a DataURL for voice clone model`。
//   · 要念的文字必须放在 role=assistant 的 messages 里；voiceclone 不需要 user 消息。
//   · 克隆合成偏慢：冷调用实测 44~112 秒，热起来 2 秒左右 → 默认超时给 180 秒。
//   · 参考音频路径要容忍 Windows「复制为路径」带进来的那对双引号（否则必 ENOENT）。
//
// 启动：双击「启动.bat」，或命令行 `node server.mjs`
// 只监听 127.0.0.1，不对外开端口；Key 只存在本目录的 config.json 里。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const REF_DIR = path.join(APP_DIR, 'refs');
const OUT_DIR = path.join(APP_DIR, 'output');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const PORT = Number(process.env.PORT) || 8391;

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  refPath: '',
  format: 'mp3',
  timeoutMs: 180000,
  style: ''            // 上次用的语气指令（自然语言那一套），纯本地记忆
};
const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone';
const MAX_REF_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 500;

for (const d of [REF_DIR, OUT_DIR, PUBLIC_DIR]) fs.mkdirSync(d, { recursive: true });

// ── 日志（同时写控制台与文件）────────────────────────────────────────────────
// 为什么要落文件：启动器窗口一闪就没时（编码/端口/Node 缺失），光看浏览器只会是
// 「拒绝连接」，什么线索都没有。这里把控制台输出全部镜像到 startup.log。
// 文件名刻意用 ASCII：启动 .bat 里要 echo 它，中文字符串会把 .bat 拖回编码问题。
const LOG_FILE = path.join(APP_DIR, 'startup.log');
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    try {
      fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleString('zh-CN')}] ${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`);
    } catch { /* 日志写不进去不影响主流程 */ }
  };
}
console.log(`启动：node ${process.version} · 目录 ${APP_DIR} · 端口 ${PORT}`);

// ── 配置读写 ────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  if (!/^https?:\/\//i.test(String(next.baseUrl || ''))) next.baseUrl = DEFAULTS.baseUrl;
  next.baseUrl = String(next.baseUrl).replace(/\/+$/, '');
  next.format = String(next.format).toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const t = Number(next.timeoutMs);
  next.timeoutMs = Number.isFinite(t) ? Math.min(600000, Math.max(30000, Math.round(t))) : DEFAULTS.timeoutMs;
  next.style = String(next.style ?? '').slice(0, 2000);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
/**
 * 首次运行时生成一份空配置（apiKey 留空）。
 *
 * 为什么：config.json 里存着 Key，所以它被 .gitignore 排除、不进仓库；
 * 但克隆下来的人需要一个能跑起来的起点 —— 启动时补一份空白模板，
 * 页面进去就是「未配置 API Key」，填了保存即可。已存在则一个字节都不动。
 */
function ensureConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) return false;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  return true;
}

// ── 参考音频 ────────────────────────────────────────────────────────────────
/** 剥掉成对的引号与首尾空格（Windows「复制为路径」会带一对双引号）。 */
function cleanPath(input) {
  let s = String(input ?? '').trim();
  for (const [a, b] of [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['`', '`']]) {
    if (s.length >= 2 && s.startsWith(a) && s.endsWith(b)) { s = s.slice(1, -1).trim(); break; }
  }
  return s;
}
function resolveRef(p) {
  const s = cleanPath(p);
  if (!s) return '';
  return path.isAbsolute(s) ? s : path.resolve(APP_DIR, s);
}
const refCache = new Map();
/** 读参考音频 → { dataUrl, kind, bytes, name, path, cached }；不合法就抛带人话的错误。 */
function readRef(refPath) {
  const p = resolveRef(refPath);
  if (!p) throw new Error('还没选参考音频（点「选择音频」或把 mp3/wav 拖进来）');
  let st;
  try { st = fs.statSync(p); } catch (e) {
    throw new Error(`参考音频读不到：${p}（${e?.code || e?.message}）`);
  }
  if (!st.isFile() || st.size <= 0) throw new Error(`参考音频不是有效文件：${p}`);
  if (st.size > MAX_REF_BYTES) {
    throw new Error(`参考音频太大（${(st.size / 1048576).toFixed(1)}MB，上限 ${MAX_REF_BYTES / 1048576}MB）—— 裁到 15 秒以内或转成 mp3 再试`);
  }
  const hit = refCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.bytes === st.size) return { ...hit, cached: true };
  const buf = fs.readFileSync(p);
  const head = buf.subarray(0, 12).toString('latin1');
  const isWav = head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE';
  const isMp3 = head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  if (!isWav && !isMp3) throw new Error('参考音频既不是 wav 也不是 mp3 —— 官方只接受这两种格式');
  const kind = isWav ? 'wav' : 'mp3';
  const b64 = buf.toString('base64');
  const entry = {
    dataUrl: `data:${isWav ? 'audio/wav' : 'audio/mpeg'};base64,${b64}`,
    kind, bytes: st.size, name: path.basename(p), path: p, mtimeMs: st.mtimeMs, cached: false
  };
  refCache.set(p, entry);
  return entry;
}

// ── 调用 MiMo ───────────────────────────────────────────────────────────────
function hintFor(status) {
  if (status === 401 || status === 403) return 'API Key 不对或没有权限（确认 Key 与接口地址是同一家的）';
  if (status === 404) return '接口地址不对（改回官方 https://api.xiaomimimo.com/v1）';
  if (status === 429) return '调用太频繁，或额度/余额用尽';
  if (status === 400) return '参数被拒（看下面的服务端原文，多半是参考音频格式问题）';
  if (status >= 500) return 'MiMo 服务端异常，稍后重试';
  return '';
}

async function synthesize({ text, style }) {
  const c = loadConfig();
  if (!String(c.apiKey || '').trim()) throw new Error('还没填 MiMo API Key（在「设置」里填）');
  const spoken = String(text ?? '').trim();
  if (!spoken) throw new Error('要合成的文字是空的');
  if (spoken.length > MAX_TEXT_CHARS) throw new Error(`文字太长（${spoken.length} 字，上限 ${MAX_TEXT_CHARS} 字）—— 拆成几句分别合成`);

  const ref = readRef(c.refPath);
  const t0 = Date.now();
  // ── 语气控制（官方两套，实测都作用于克隆模型）──────────────────────────
  //   ① 自然语言指令 → 放在 role=user 的 content 里（不念出来）
  //   ② 音频标签     → 写在 role=assistant 的文本里：(风格) 放开头，[细粒度标签] 可插任意位置
  //   克隆模式不支持"唱歌"，其余风格/情绪/方言/角色扮演都可以叠加使用。
  const styleText = String(style ?? '').trim();
  const messages = [];
  if (styleText) messages.push({ role: 'user', content: styleText });
  messages.push({ role: 'assistant', content: spoken });
  let res;
  try {
    res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'api-key': c.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLONE_MODEL,
        messages,
        audio: { format: c.format, voice: ref.dataUrl },
        stream: false
      }),
      signal: AbortSignal.timeout(c.timeoutMs)
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError'
      ? `等满 ${(c.timeoutMs / 1000).toFixed(0)} 秒没返回（克隆冷启动可能要 1~2 分钟，可把超时调大）`
      : (e?.cause?.message || e?.message || e);
    throw new Error(`连不上 MiMo：${why}`);
  }
  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText.slice(0, 400);
    try { const j = JSON.parse(bodyText); detail = j?.error?.param ? `${j.error.message}（字段 ${j.error.param}）` : (j?.error?.message || detail); } catch { /* 保留原文 */ }
    throw new Error(`MiMo 返回 HTTP ${res.status}${hintFor(res.status) ? `：${hintFor(res.status)}` : ''}\n${detail}`);
  }
  let data = null;
  try { data = JSON.parse(bodyText); } catch { throw new Error(`MiMo 返回的不是 JSON：${bodyText.slice(0, 200)}`); }
  if (data?.error) throw new Error(`MiMo 报错：${typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error))}`);
  const b64 = String(data?.choices?.[0]?.message?.audio?.data || '').trim();
  if (!b64) throw new Error(`没拿到音频数据（原始响应：${bodyText.slice(0, 200)}）`);

  const audio = Buffer.from(b64, 'base64');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // 文件名用"去掉标签后的正话"：开头 (风格) 与句中 [标签] 都不该出现在文件名里
  const plain = spoken
    .replace(/^\s*[（(\[][^）)\]]{1,30}[）)\]]\s*/, '')
    .replace(/\[[^\]]{1,20}\]/g, '')
    .trim();
  const safe = (plain.slice(0, 12) || 'voice').replace(/[\\/:*?"<>|\s]+/g, '_');
  const file = `${stamp}_${safe}.${c.format}`;
  fs.writeFileSync(path.join(OUT_DIR, file), audio);
  const ms = Date.now() - t0;
  console.log(`[合成] ${spoken.length} 字 · ${styleText ? '带语气指令' : '无语气指令'} · ${(audio.length / 1024).toFixed(0)}KB · ${(ms / 1000).toFixed(1)}s · ref=${ref.name}`);
  return { file, ms, bytes: audio.length, chars: spoken.length, refName: ref.name, cached: ref.cached, styled: Boolean(styleText) };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function readBody(req, limit = 14 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};
const maskKey = (k) => {
  const s = String(k || '');
  return s ? `${s.slice(0, 6)}${'*'.repeat(Math.max(0, Math.min(10, s.length - 10)))}${s.slice(-4)}` : '';
};
function safeJoin(baseDir, name) {
  const clean = path.basename(String(name || ''));
  if (!clean || clean !== String(name || '')) return '';
  return path.join(baseDir, clean);
}
function listOutputs() {
  try {
    return fs.readdirSync(OUT_DIR)
      .filter((f) => /\.(mp3|wav)$/i.test(f))
      .map((f) => ({ file: f, bytes: fs.statSync(path.join(OUT_DIR, f)).size, mtime: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 30);
  } catch { return []; }
}
function listRefs() {
  try {
    return fs.readdirSync(REF_DIR)
      .filter((f) => /\.(mp3|wav)$/i.test(f))
      .map((f) => ({ file: f, name: f, bytes: fs.statSync(path.join(REF_DIR, f)).size }))
      .sort((a, b) => a.file.localeCompare(b.file));
  } catch { return []; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    // 页面
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    // 状态
    if (req.method === 'GET' && p === '/api/state') {
      const c = loadConfig();
      let ref = null;
      if (c.refPath) { try { const r = readRef(c.refPath); ref = { name: r.name, kind: r.kind, bytes: r.bytes, path: r.path }; } catch (e) { ref = { error: String(e.message) }; } }
      return sendJson(res, 200, {
        hasKey: Boolean(String(c.apiKey || '').trim()), keyMasked: maskKey(c.apiKey),
        baseUrl: c.baseUrl, format: c.format, timeoutMs: c.timeoutMs, style: c.style || '',
        refPath: c.refPath, ref, refs: listRefs(), outputs: listOutputs(), model: CLONE_MODEL
      });
    }
    // 保存设置
    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
      if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl.trim();
      if (typeof body.refPath === 'string') patch.refPath = body.refPath.trim();
      if (typeof body.format === 'string') patch.format = body.format;
      if (typeof body.style === 'string') patch.style = body.style.slice(0, 2000);
      if (body.timeoutMs !== undefined) patch.timeoutMs = Number(body.timeoutMs);
      const next = saveConfig(patch);
      return sendJson(res, 200, { ok: true, hasKey: Boolean(next.apiKey.trim()), baseUrl: next.baseUrl, format: next.format, timeoutMs: next.timeoutMs, refPath: next.refPath, style: next.style });
    }
    // 上传/入住参考音频（页面用 FileReader 送 base64，避免引入 multipart 依赖）
    if (req.method === 'POST' && p === '/api/ref') {
      const body = await readBody(req);
      const name = path.basename(String(body.name || 'ref'));
      const m = /^data:audio\/[a-z0-9.+-]+;base64,(.+)$/i.exec(String(body.dataUrl || ''));
      if (!m) return sendJson(res, 400, { ok: false, error: '只接受音频文件（mp3 / wav）' });
      const buf = Buffer.from(m[1], 'base64');
      if (!buf.length) return sendJson(res, 400, { ok: false, error: '文件是空的' });
      if (buf.length > MAX_REF_BYTES) return sendJson(res, 400, { ok: false, error: `文件太大（${(buf.length / 1048576).toFixed(1)}MB，上限 ${MAX_REF_BYTES / 1048576}MB）` });
      const ext = /\.wav$/i.test(name) ? 'wav' : (/\.mp3$/i.test(name) ? 'mp3' : '');
      const head = buf.subarray(0, 12).toString('latin1');
      const kind = (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') ? 'wav' : ((head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) ? 'mp3' : '');
      if (!kind) return sendJson(res, 400, { ok: false, error: '这不是 mp3/wav 音频（官方只接受这两种）' });
      const finalName = ext ? name : `${name.replace(/\.[^.]+$/, '')}.${kind}`;
      fs.writeFileSync(path.join(REF_DIR, finalName), buf);
      const next = saveConfig({ refPath: path.join(REF_DIR, finalName) });
      console.log(`[参考音频] 已保存 ${finalName}（${(buf.length / 1024).toFixed(0)}KB）`);
      return sendJson(res, 200, { ok: true, file: finalName, refPath: next.refPath, bytes: buf.length, kind });
    }
    // 选中已有参考音频
    if (req.method === 'POST' && p === '/api/ref/select') {
      const body = await readBody(req);
      const name = path.basename(String(body.file || ''));
      const full = safeJoin(REF_DIR, name);
      if (!full || !fs.existsSync(full)) return sendJson(res, 404, { ok: false, error: '文件不存在' });
      const next = saveConfig({ refPath: full });
      return sendJson(res, 200, { ok: true, refPath: next.refPath });
    }
    // 合成
    if (req.method === 'POST' && p === '/api/synthesize') {
      const body = await readBody(req);
      try {
        const r = await synthesize({ text: body.text, style: body.style });
        // 顺手把语气指令记住（下次打开还在），但**不**记进任何日志
        if (typeof body.style === 'string') saveConfig({ style: body.style.slice(0, 2000) });
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        console.warn('[合成失败]', String(e?.message || e).split('\n')[0]);
        return sendJson(res, 200, { ok: false, error: String(e?.message || e) });
      }
    }
    // 试听：/out/<file>、/ref/<file>
    if (req.method === 'GET' && (p.startsWith('/out/') || p.startsWith('/ref/'))) {
      const isOut = p.startsWith('/out/');
      const file = decodeURIComponent(isOut ? p.slice(5) : p.slice(5));
      const full = safeJoin(isOut ? OUT_DIR : REF_DIR, file);
      if (!full || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': /\.wav$/i.test(file) ? 'audio/wav' : 'audio/mpeg', 'cache-control': 'no-store' });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${PORT} 已被占用 —— 多半是已经有一个本程序在跑了。`);
    console.error('       关掉那个窗口（或改端口：set PORT=8392 && node server.mjs）后重试。\n');
  } else {
    console.error('[错误]', e?.message || e);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const created = ensureConfigFile();
  const c = loadConfig();
  const url = `http://127.0.0.1:${PORT}`;
  console.log('──────────────────────────────────────────────');
  console.log('  MiMo 语音克隆 · 已启动');
  if (created) console.log('  已生成空白 config.json（apiKey 留空，在页面上填好保存即可）');
  console.log(`  地址：${url}`);
  console.log(`  API Key：${c.apiKey ? '已配置(' + maskKey(c.apiKey) + ')' : '未配置（在页面上填）'}`);
  console.log(`  参考音频：${c.refPath || '未选择'}`);
  console.log(`  输出目录：${OUT_DIR}`);
  console.log('  关闭这个窗口即停止。');
  console.log('──────────────────────────────────────────────');
  // 浏览器由服务端在"真的监听成功之后"打开 —— 比放在 .bat 里 sleep 2 秒再开可靠
  // （Node 冷启动、杀毒扫描都可能让 2 秒不够，用户看到的就是"拒绝连接"）。
  if (process.env.NO_OPEN !== '1') {
    try {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      console.log('  已尝试打开浏览器（没弹出就手动访问上面的地址）');
    } catch (e) {
      console.log(`  打开浏览器失败（不影响使用，手动访问即可）：${e?.message || e}`);
    }
  }
});

process.on('uncaughtException', (e) => {
  console.error('[未捕获异常]', e?.stack || e?.message || e);
  process.exit(1);
});
