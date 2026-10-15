/**
 * 站点渲染：本地预览与 GitHub Pages 静态构建共用同一套模板。
 *
 * 所有链接都写成相对路径，因此同一份产物既能跑在站点根目录
 * （http://localhost:5173/），也能跑在 GitHub Pages 的项目子路径
 * （https://<user>.github.io/<repo>/），无需配置 base。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown, parseFrontmatter } from './markdown.mjs';

// 再导出底层原语，让 server.mjs 只需依赖 site.mjs 一个模块。
export { renderMarkdown, parseFrontmatter };

export const SITE_TITLE = '我的博客';
export const SITE_DESC = '用 Markdown 写作的静态博客';

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 从 Markdown 正文抽一段纯文本摘要。 */
export function summarize(markdown, limit = 140) {
  const plain = String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^---[\s\S]*?---/m, ' ')
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? plain.slice(0, limit) + '…' : plain;
}

/** 生成安全带引号的 YAML 字符串值。 */
export function yamlString(s) {
  return `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

/**
 * 把一篇文章序列化回 Markdown（frontmatter + 正文）。
 * 与 parseFrontmatter 互为逆操作，供编辑器保存时使用。
 */
export function serializePost({ title, date, category, tags, body }) {
  const tagList = (Array.isArray(tags) ? tags : String(tags ?? '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);

  const lines = ['---'];
  lines.push(`title: ${yamlString(title)}`);
  lines.push(`date: ${yamlString(date)}`);
  if (category) lines.push(`category: ${yamlString(category)}`);
  lines.push(`tags: [${tagList.join(', ')}]`);
  lines.push('---', '');
  lines.push(String(body ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
  lines.push('');
  return lines.join('\n');
}

/** 把标题转成安全的文件名片段（保留中文）。 */
export function slugify(s, maxLen = 50) {
  return (
    String(s ?? '')
      .trim()
      .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, maxLen) || 'untitled'
  );
}

/** 读取 posts/ 下的全部 Markdown，按日期倒序返回。 */
export function loadPosts(postsDir) {
  if (!existsSync(postsDir)) return [];
  const posts = [];
  for (const file of readdirSync(postsDir)) {
    if (!/\.md$/i.test(file)) continue;
    const full = join(postsDir, file);
    let raw, mtimeMs;
    try {
      const st = statSync(full);
      mtimeMs = st.mtimeMs;
      raw = readFileSync(full, 'utf8');
    } catch (err) {
      console.error(`跳过 ${file}: ${err.message}`);
      continue;
    }

    const { data, content } = parseFrontmatter(raw);
    const slug = file.replace(/\.md$/i, '');
    const rendered = renderMarkdown(content);

    // 正文首行的 <h1> 提到页头，避免与模板标题重复。
    const h1 = /^\s*<h1>([\s\S]*?)<\/h1>\s*/.exec(rendered);
    const title = data.title || (h1 ? h1[1].replace(/<[^>]+>/g, '') : slug);
    const body = h1 ? rendered.slice(h1[0].length) : rendered;

    posts.push({
      slug,
      file,
      title,
      date: data.date || new Date(mtimeMs).toLocaleString('zh-CN'),
      category: data.category || '',
      tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
      summary: summarize(content),
      body,
      mtime: mtimeMs,
    });
  }
  return posts.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.mtime - a.mtime);
}

/* ------------------------------------------------------------------ */
/* 模板                                                                */
/* ------------------------------------------------------------------ */

/** 文章页在 dist/p/<slug>/ 下，相对站点根是两层。 */
export const POST_DEPTH = 2;

const rel = (depth, path) => (depth ? '../'.repeat(depth) : '') + path;

/** 指向站点根目录的相对路径：depth 0 → './'，depth 2 → '../../'。 */
const up = (depth) => (depth ? '../'.repeat(depth) : './');

function layout({ title, body, count, depth = 0 }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(SITE_DESC)}">
<link rel="stylesheet" href="${rel(depth, 'style.css')}">
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${up(depth)}">${escapeHtml(SITE_TITLE)}</a>
    <span class="tagline">${escapeHtml(count)}</span>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer><div class="wrap">${escapeHtml(SITE_DESC)} · 由 Node 内置模块驱动，零依赖</div></footer>
</body>
</html>`;
}

export function renderIndex(posts) {
  if (!posts.length) {
    return layout({
      title: SITE_TITLE,
      count: '还没有文章',
      body: `<p class="empty">还没有文章。运行 <code>node scripts/export-session.mjs</code> 导出第一篇。</p>`,
    });
  }
  const items = posts
    .map((p) => {
      const pills = [p.category, ...p.tags]
        .filter(Boolean)
        .map((t) => `<span class="pill">${escapeHtml(t)}</span>`)
        .join('');
      return `<li>
  <h2><a href="${rel(0, `p/${encodeURIComponent(p.slug)}/`)}">${escapeHtml(p.title)}</a></h2>
  <p class="meta"><span>${escapeHtml(p.date)}</span>${pills}</p>
  <p class="summary">${escapeHtml(p.summary)}</p>
</li>`;
    })
    .join('\n');
  return layout({
    title: SITE_TITLE,
    count: `共 ${posts.length} 篇文章`,
    body: `<ul class="post-list">\n${items}\n</ul>`,
  });
}

export function renderPost(post, posts) {
  const pills = [post.category, ...post.tags]
    .filter(Boolean)
    .map((t) => `<span class="pill">${escapeHtml(t)}</span>`)
    .join('');
  return layout({
    title: `${post.title} · ${SITE_TITLE}`,
    count: `共 ${posts.length} 篇文章`,
    depth: POST_DEPTH,
    body: `<a class="back" href="${up(POST_DEPTH)}">← 返回首页</a>
<article>
  <h1>${escapeHtml(post.title)}</h1>
  <p class="meta"><span>${escapeHtml(post.date)}</span>${pills}</p>
  <div class="content">
${post.body}
  </div>
</article>`,
  });
}
