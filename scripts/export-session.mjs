#!/usr/bin/env node
/**
 * 把一段 dsh 会话导出成一篇 Markdown 博客文章（零依赖）。
 *
 * 只读 dsh 的会话日志（默认 %USERPROFILE%\.dsh\sessions），
 * 绝不向 C 盘写入任何内容；产物只落在本博客的 posts/ 目录。
 *
 * 用法：
 *   node scripts/export-session.mjs                 导出最新一段会话
 *   node scripts/export-session.mjs --list          列出可导出的会话
 *   node scripts/export-session.mjs --session <id>  指定会话（id 前缀即可）
 *   node scripts/export-session.mjs --title "标题"  覆盖文章标题
 *   node scripts/export-session.mjs --reasoning     连思考过程一起导出
 *   node scripts/export-session.mjs --debug         打印内容类型统计后退出
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOG_ROOT = resolve(HERE, '..');
const DEFAULT_OUT = join(BLOG_ROOT, 'posts');
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, session: null, title: null, list: false, reasoning: false, debug: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--reasoning') opts.reasoning = true;
    else if (a === '--debug') opts.debug = true;
    else if (a === '--session') opts.session = argv[++i] ?? null;
    else if (a === '--title') opts.title = argv[++i] ?? null;
    else if (a === '--out') opts.out = resolve(argv[++i] ?? DEFAULT_OUT);
    else if (a === '-h' || a === '--help') opts.help = true;
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* 会话日志读取                                                        */
/* ------------------------------------------------------------------ */

/**
 * dsh 的 session.v*.jsonl.zstd 是「多个 zstd 帧首尾相接」的容器，
 * 不是单一压缩流 —— 直接 zstdDecompressSync 整份只会得到第一帧。
 * 所以这里按魔数切帧，逐帧解压后拼接。
 */
export function decodeSessionBuffer(buf) {
  const offsets = [];
  let idx = buf.indexOf(ZSTD_MAGIC, 0);
  while (idx !== -1) {
    offsets.push(idx);
    idx = buf.indexOf(ZSTD_MAGIC, idx + 4);
  }
  if (!offsets.length) return buf.toString('utf8'); // 未压缩的兜底

  let text = '';
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {
      // 单帧损坏不应让整次导出失败。
    }
  }
  return text;
}

function listSessions() {
  if (!existsSync(SESSIONS_ROOT)) return [];
  const found = [];
  for (const workspace of readdirSync(SESSIONS_ROOT)) {
    const wsDir = join(SESSIONS_ROOT, workspace);
    let entries;
    try {
      if (!statSync(wsDir).isDirectory()) continue;
      entries = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(wsDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
        for (const f of readdirSync(dir)) {
          if (!/^session\.v\d+\.jsonl\.zstd$/.test(f)) continue;
          const file = join(dir, f);
          const st = statSync(file);
          found.push({ id: entry, workspace, file, mtime: st.mtimeMs, size: st.size });
        }
      } catch {
        continue;
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/* ------------------------------------------------------------------ */
/* 记录解析                                                            */
/* ------------------------------------------------------------------ */

function readRecords(file) {
  const raw = decodeSessionBuffer(readFileSync(file));
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function textFrom(blocks, { reasoning = false } = {}) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (reasoning && b.type === 'reasoning' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n\n').trim();
}

/** 抽出「纯对话」：只有用户的提问和助手的正文回复，不含工具调用。 */
export function extractTurns(records, { reasoning = false } = {}) {
  const turns = [];
  for (const r of records) {
    if (r?.type === 'user/message') {
      // dsh 会把运行上下文、技能目录等也记成 user/message，
      // 用 source.kind 区分：真人发言是 'user'，注入内容不是。
      if (r.data?.source?.kind !== 'user') continue;
      const text = textFrom(r.data?.content, { reasoning: false });
      if (text) turns.push({ role: 'user', text, time: r.time });
    } else if (r?.type === 'assistant/message') {
      const text = textFrom(r.data?.message?.content, { reasoning });
      if (text) turns.push({ role: 'assistant', text, time: r.time });
    }
  }
  return turns;
}

function sessionTitle(records) {
  // 取最后一条非 fallback 的标题（通常来自模型总结），否则退回 fallback。
  const titles = records.filter((r) => r?.type === 'session/title' && r.data?.title);
  const preferred = [...titles].reverse().find((r) => r.data?.source?.kind !== 'fallback');
  return (preferred ?? titles[titles.length - 1])?.data?.title ?? null;
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0');
}
function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function stampFile(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function slugify(s) {
  return String(s)
    .trim()
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'untitled';
}

function yamlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildMarkdown({ title, turns, sessionId, when }) {
  const lines = [];
  lines.push('---');
  lines.push(`title: ${yamlString(title)}`);
  lines.push(`date: ${yamlString(stamp(when))}`);
  lines.push(`category: ${yamlString('对话导出')}`);
  lines.push(`tags: [对话导出, dsh]`);
  lines.push(`session: ${yamlString(sessionId)}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> 导出自 dsh 会话 · ${stamp(when)} · 共 ${turns.filter((t) => t.role === 'user').length} 轮对话`);
  lines.push('');

  let first = true;
  for (const turn of turns) {
    if (turn.role === 'user') {
      if (!first) lines.push('---', '');
      first = false;
      lines.push('**我**', '');
    } else {
      lines.push('**dsh**', '');
    }
    lines.push(turn.text, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
    return;
  }

  const sessions = listSessions();
  if (!sessions.length) {
    console.error(`没有在 ${SESSIONS_ROOT} 找到任何会话日志。`);
    process.exitCode = 1;
    return;
  }

  if (opts.list) {
    console.log(`共 ${sessions.length} 段会话（新 → 旧）：\n`);
    for (const s of sessions.slice(0, 30)) {
      const when = new Date(s.mtime).toLocaleString('zh-CN');
      console.log(`  ${when}  ${s.id}  [${s.workspace}]`);
    }
    return;
  }

  const target = opts.session
    ? sessions.find((s) => s.id === opts.session || s.id.includes(opts.session))
    : sessions[0];

  if (!target) {
    console.error(`找不到匹配 --session ${opts.session} 的会话。用 --list 看看有哪些。`);
    process.exitCode = 1;
    return;
  }

  const records = readRecords(target.file);
  const turns = extractTurns(records, { reasoning: opts.reasoning });

  if (opts.debug) {
    const types = {};
    for (const r of records) {
      if (r?.type !== 'user/message' && r?.type !== 'assistant/message') continue;
      const blocks = r.type === 'user/message' ? r.data?.content : r.data?.message?.content;
      for (const b of blocks ?? []) types[`${r.type}:${b?.type}`] = (types[`${r.type}:${b?.type}`] ?? 0) + 1;
    }
    console.log('会话:', target.id);
    console.log('记录数:', records.length, '| 抽取轮次:', turns.length);
    console.log('内容块类型统计:', JSON.stringify(types, null, 1));
    console.log('\n首轮预览:\n' + (turns[0]?.text ?? '(空)').slice(0, 400));
    return;
  }

  if (!turns.length) {
    console.error('这段会话里没有可导出的对话正文。');
    process.exitCode = 1;
    return;
  }

  const when = new Date();
  const title = opts.title || sessionTitle(records) || `dsh 会话 ${stamp(when)}`;
  const md = buildMarkdown({ title, turns, sessionId: target.id, when });

  mkdirSync(opts.out, { recursive: true });
  const filename = `${stampFile(when)}-${slugify(title)}.md`;
  const dest = join(opts.out, filename);
  writeFileSync(dest, md, 'utf8');

  console.log('已导出文章:');
  console.log('  标题  ', title);
  console.log('  轮次  ', turns.filter((t) => t.role === 'user').length, '轮');
  console.log('  会话  ', target.id);
  console.log('  文件  ', dest);
}

main();
