#!/usr/bin/env node
/**
 * 本地预览服务器（零依赖）。
 *
 * 对外伺服的正是 build-static.mjs 构建出的 dist/ ——
 * 也就是说本地看到的就是将来部署到 GitHub Pages 的那份产物，
 * 不存在"本地和线上不一致"的问题。
 *
 * posts/ 内容有变化时自动重新构建，刷新浏览器即可。
 *
 * 用法：
 *   node server.mjs                 默认 http://127.0.0.1:5173
 *   node server.mjs --port 8080
 *   node server.mjs --host 0.0.0.0
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, BLOG_ROOT, POSTS_DIR } from './scripts/build-static.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(BLOG_ROOT, 'dist');

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

/** posts/ 与 assets/ 的指纹：文件名 + mtime，用来判断要不要重建。 */
function signature() {
  const parts = [];
  for (const dir of [POSTS_DIR, join(BLOG_ROOT, 'assets')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      try {
        parts.push(f + ':' + statSync(join(dir, f)).mtimeMs);
      } catch {
        /* 文件刚被删掉，忽略 */
      }
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
/* 静态文件服务                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 把 URL 路径安全地映射到 dist/ 内的文件，拒绝目录穿越。 */
function resolveInDist(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  clean = clean.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = normalize(join(DIST, clean));
  if (full !== DIST && !full.startsWith(DIST + sep)) return null;
  return full;
}

function pickFile(full) {
  if (!full) return null;
  try {
    if (statSync(full).isFile()) return full;
  } catch {
    /* 不存在，继续尝试目录索引 */
  }
  const idx = join(full, 'index.html');
  try {
    if (statSync(idx).isFile()) return idx;
  } catch {
    /* 也没有 */
  }
  return null;
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return send(res, 400, 'Bad Request', 'text/plain; charset=utf-8');
  }

  if (pathname === '/health') return send(res, 200, 'ok', 'text/plain; charset=utf-8');

  try {
    if (ensureBuilt()) console.log('检测到 posts/ 变化，已重新构建');

    const file = pickFile(resolveInDist(pathname));
    if (!file) {
      return send(res, 404, '<!doctype html><meta charset="utf-8"><p>404 · 页面不存在。<a href="/">返回首页</a></p>');
    }
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, readFileSync(file), type);
  } catch (err) {
    console.error(err);
    return send(res, 500, 'Internal Server Error: ' + err.message, 'text/plain; charset=utf-8');
  }
});

/* ------------------------------------------------------------------ */
/* 启动（端口被占用时自动顺延）                                          */
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
    const built = ensureBuilt(true);
    const url = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${port}`;
    console.log(`博客已启动: ${url}${built ? ' (已构建 dist/)' : ''}`);
    console.log(`文章目录  : ${POSTS_DIR}`);
    console.log('按 Ctrl+C 停止。');
  });
}

listen(opts.port, 10);
