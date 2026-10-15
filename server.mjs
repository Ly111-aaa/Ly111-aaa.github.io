#!/usr/bin/env node
/**
 * 本地博客服务器（零依赖）：既伺服站点，也提供可视化编辑器。
 *
 *   博客   http://127.0.0.1:5173/      伺服 dist/（与 GitHub Pages 同一份产物）
 *   编辑器 http://127.0.0.1:5173/edit  网页里写标题正文，保存成 Markdown，一键推送
 *
 * 安全设计：只监听回环地址；校验 Host 头（挡 DNS rebinding）；
 * 所有写操作都要求启动时随机生成的 token，而 token 只内嵌在同源返回的 /edit 页面里。
 *
 * 用法：
 *   node server.mjs                 默认 http://127.0.0.1:5173
 *   node server.mjs --port 8080
 */

import { createServer } from 'node:http';
import {
  readFileSync, writeFileSync, existsSync, statSync, readdirSync,
  unlinkSync, openSync, closeSync, mkdirSync,
} from 'node:fs';
import { join, extname, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildSite, BLOG_ROOT, POSTS_DIR } from './scripts/build-static.mjs';
import { parseFrontmatter, serializePost, slugify, renderMarkdown } from './scripts/site.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(BLOG_ROOT, 'dist');
const EDITOR_HTML = join(BLOG_ROOT, 'assets', 'editor.html');
const TOKEN = randomBytes(16).toString('hex');

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { port: 5173, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = Number(argv[++i]) || 5173;
    else if (argv[i] === '--host') opts.host = argv[++i] || '127.0.0.1';
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* 构建与变更检测                                                       */
/* ------------------------------------------------------------------ */

function signature() {
  const parts = [];
  for (const dir of [POSTS_DIR, join(BLOG_ROOT, 'assets')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f === 'editor.html') continue; // 编辑器本身不进站点产物
      try {
        parts.push(f + ':' + statSync(join(dir, f)).mtimeMs);
      } catch { /* 文件刚被删除 */ }
    }
  }
  return parts.sort().join('|');
}

let currentSig = null;

function ensureBuilt(force = false) {
  const sig = signature();
  if (!force && sig === currentSig && existsSync(join(DIST, 'index.html'))) return false;
  buildSite({ quiet: true });
  currentSig = sig;
  return true;
}

/* ------------------------------------------------------------------ */
/* 文章读写                                                            */
/* ------------------------------------------------------------------ */

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** slug 必须对应 posts/ 里的真实文件，同时挡掉路径穿越。 */
function postFile(slug) {
  if (!slug || /[\\/]/.test(slug) || slug.startsWith('.')) return null;
  const full = normalize(join(POSTS_DIR, slug + '.md'));
  if (!full.startsWith(POSTS_DIR + sep)) return null;
  return existsSync(full) ? full : null;
}

function readPostFile(slug) {
  const full = postFile(slug);
  if (!full) return null;
  const { data, content } = parseFrontmatter(readFileSync(full, 'utf8'));
  const h1 = /^\s*#\s+(.+)$/m.exec(content);
  return {
    slug,
    title: data.title || (h1 ? h1[1].trim() : slug),
    date: data.date || stamp(statSync(full).mtime),
    category: data.category || '',
    tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
    body: content.trim(),
  };
}

function listPostFiles() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter((f) => /\.md$/i.test(f))
    .map((f) => ({ slug: f.replace(/\.md$/i, ''), mtime: statSync(join(POSTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function uniqueSlug(base) {
  let slug = base;
  let i = 2;
  while (existsSync(join(POSTS_DIR, slug + '.md'))) slug = `${base}-${i++}`;
  return slug;
}

/* ------------------------------------------------------------------ */
/* 发布：构建 → git add / commit / push                                 */
/* ------------------------------------------------------------------ */

/**
 * 执行命令并把 stdout/stderr 收集到文件。
 * 刻意不用管道：受限沙箱禁止命名管道，管道会让这条路径在沙箱下直接失败。
 */
function run(cmd, args) {
  const logFile = join(tmpdir(), `blog-run-${process.pid}-${Date.now()}.log`);
  let fd;
  try {
    fd = openSync(logFile, 'w');
    const r = spawnSync(cmd, args, { cwd: BLOG_ROOT, stdio: ['ignore', fd, fd], windowsHide: true });
    closeSync(fd);
    fd = undefined;
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    return { code: r.status ?? (r.error ? -1 : 1), log: log.trim(), error: r.error?.message };
  } catch (err) {
    return { code: -1, log: '', error: err.message };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关闭 */ } }
    try { unlinkSync(logFile); } catch { /* 可能不存在 */ }
  }
}

function publish() {
  const out = [];

  // 1) 先本地构建：文章写坏了立刻发现，不会推上去
  try {
    const r = buildSite({ quiet: true });
    out.push(`本地构建通过（${r.count} 篇文章）`);
  } catch (err) {
    return { ok: false, message: '构建失败，未推送：' + err.message, log: out.join('\n') };
  }

  // 2) 暂存并看有没有实际改动
  let r = run('git', ['add', '-A']);
  if (r.code !== 0) return { ok: false, message: 'git add 失败', log: r.log || r.error };

  if (run('git', ['diff', '--cached', '--quiet']).code === 0) {
    return { ok: true, message: '内容没有变化，无需推送。', log: out.join('\n') };
  }

  // 3) 提交
  r = run('git', ['commit', '-m', `更新博客 ${stamp(new Date())}`]);
  if (r.code !== 0) {
    return { ok: false, message: 'git commit 失败', log: (out.join('\n') + '\n' + r.log).trim() };
  }
  out.push('已提交');

  // 4) 推送
  r = run('git', ['push']);
  if (r.code !== 0) {
    return {
      ok: false,
      message: '已提交，但推送失败（检查网络后可再点一次发布）',
      log: (out.join('\n') + '\n' + (r.log || r.error || '')).trim(),
    };
  }
  out.push('已推送');

  return { ok: true, message: '已发布，约 1～2 分钟后生效：https://ly111-aaa.github.io/', log: out.join('\n') };
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}
const sendJson = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function resolveInDist(urlPath) {
  let clean;
  try { clean = decodeURIComponent(urlPath); } catch { return null; }
  clean = clean.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = normalize(join(DIST, clean));
  if (full !== DIST && !full.startsWith(DIST + sep)) return null;
  return full;
}

function pickFile(full) {
  if (!full) return null;
  try { if (statSync(full).isFile()) return full; } catch { /* 继续试目录索引 */ }
  const idx = join(full, 'index.html');
  try { if (statSync(idx).isFile()) return idx; } catch { /* 没有索引 */ }
  return null;
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 只接受本机 Host，挡 DNS rebinding。 */
function hostAllowed(req) {
  const h = (req.headers.host || '').toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h);
}

const authed = (req) => req.headers['x-blog-token'] === TOKEN;

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return send(res, 400, 'Bad Request');
  }

  if (pathname === '/health') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
  if (!hostAllowed(req)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');

  const method = req.method || 'GET';

  /* ---------------- 编辑器页面（同源内嵌 token） ---------------- */

  if (pathname === '/edit' || pathname === '/edit/') {
    try {
      const html = readFileSync(EDITOR_HTML, 'utf8').replace('__BLOG_TOKEN__', TOKEN);
      return send(res, 200, html);
    } catch (err) {
      return send(res, 500, '编辑器页面缺失: ' + err.message, 'text/plain; charset=utf-8');
    }
  }

  /* ---------------- API ---------------- */

  if (pathname.startsWith('/api/')) {
    if (!authed(req)) return sendJson(res, 401, { error: '未授权：请从 /edit 页面操作' });

    try {
      // 文章列表
      if (pathname === '/api/posts' && method === 'GET') {
        const posts = listPostFiles()
          .map((f) => {
            const p = readPostFile(f.slug);
            return p ? { slug: p.slug, title: p.title, date: p.date, category: p.category, tags: p.tags } : null;
          })
          .filter(Boolean);
        return sendJson(res, 200, { posts });
      }

      // 新建
      if (pathname === '/api/posts' && method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        const title = String(b.title || '').trim();
        if (!title) return sendJson(res, 400, { error: '标题不能为空' });
        const slug = uniqueSlug(slugify(title));
        writeFileSync(
          join(POSTS_DIR, slug + '.md'),
          serializePost({ title, date: stamp(new Date()), category: b.category, tags: b.tags, body: b.body }),
          'utf8',
        );
        return sendJson(res, 201, { ok: true, slug });
      }

      // Markdown 预览
      if (pathname === '/api/preview' && method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        return sendJson(res, 200, { html: renderMarkdown(String(b.body || '')) });
      }

      // 发布到 GitHub
      if (pathname === '/api/publish' && method === 'POST') {
        const r = publish();
        return sendJson(res, r.ok ? 200 : 500, r);
      }

      // 单篇读写删
      const m = /^\/api\/posts\/(.+)$/.exec(pathname);
      if (m) {
        let slug;
        try { slug = decodeURIComponent(m[1]); } catch { return sendJson(res, 400, { error: 'slug 编码错误' }); }

        if (method === 'GET') {
          const p = readPostFile(slug);
          return p ? sendJson(res, 200, p) : sendJson(res, 404, { error: '文章不存在' });
        }

        if (method === 'PUT') {
          const full = postFile(slug);
          if (!full) return sendJson(res, 404, { error: '文章不存在' });
          const b = JSON.parse((await readBody(req)) || '{}');
          const title = String(b.title || '').trim();
          if (!title) return sendJson(res, 400, { error: '标题不能为空' });
          const old = parseFrontmatter(readFileSync(full, 'utf8'));
          writeFileSync(
            full,
            serializePost({
              title,
              date: old.data.date || stamp(new Date()),
              category: b.category,
              tags: b.tags,
              body: b.body,
            }),
            'utf8',
          );
          return sendJson(res, 200, { ok: true, slug });
        }

        if (method === 'DELETE') {
          const full = postFile(slug);
          if (!full) return sendJson(res, 404, { error: '文章不存在' });
          unlinkSync(full);
          return sendJson(res, 200, { ok: true, slug });
        }
      }

      return sendJson(res, 404, { error: '未知接口: ' + pathname });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  /* ---------------- 站点静态文件 ---------------- */

  try {
    if (ensureBuilt()) console.log('检测到 posts/ 变化，已重新构建');
    const file = pickFile(resolveInDist(pathname));
    if (!file) {
      return send(res, 404, '<!doctype html><meta charset="utf-8"><p>404 · 页面不存在。<a href="/">返回首页</a> · <a href="/edit">打开编辑器</a></p>');
    }
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, readFileSync(file), type);
  } catch (err) {
    return send(res, 500, 'Internal Server Error: ' + err.message, 'text/plain; charset=utf-8');
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const opts = parseArgs(process.argv.slice(2));

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`端口 ${port} 被占用，改用 ${port + 1} …`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, opts.host, () => {
    ensureBuilt(true);
    const hostPart = opts.host === '0.0.0.0' ? 'localhost' : opts.host;
    console.log('');
    console.log(`  博客     http://${hostPart}:${port}/`);
    console.log(`  编辑器   http://${hostPart}:${port}/edit`);
    console.log(`  文章目录 ${POSTS_DIR}`);
    console.log('');
    console.log('  在编辑器里写标题和正文 → 保存 → 发布到 GitHub。');
    console.log('  按 Ctrl+C 停止。');
    console.log('');
  });
}

listen(opts.port, 10);
