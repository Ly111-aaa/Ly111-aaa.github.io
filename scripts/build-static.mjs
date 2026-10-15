#!/usr/bin/env node
/**
 * 把 posts/*.md 构建成可直接部署的静态站点（dist/）。
 *
 * 零依赖：只用 Node 内置模块，CI 里也不需要 npm install。
 * 产物用相对链接，因此同一份 dist/ 既能在本地根路径预览，
 * 也能直接放到 GitHub Pages 的项目子路径下。
 *
 * 用法：
 *   node scripts/build-static.mjs                 构建到 dist/
 *   node scripts/build-static.mjs --out public    换个输出目录
 */

import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPosts, renderIndex, renderPost, POST_DEPTH } from './site.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BLOG_ROOT = resolve(HERE, '..');
export const POSTS_DIR = join(BLOG_ROOT, 'posts');
const STYLE_FILE = join(BLOG_ROOT, 'assets', 'style.css');

/**
 * 构建静态站点。
 * @param {{outDir?: string, postsDir?: string, quiet?: boolean}} opts
 * @returns {{outDir: string, count: number, files: string[]}}
 */
export function buildSite(opts = {}) {
  const outDir = resolve(opts.outDir ?? join(BLOG_ROOT, 'dist'));
  const postsDir = resolve(opts.postsDir ?? POSTS_DIR);

  // 安全闸：只允许清理 blog 目录内的输出目录，避免误删。
  const insideBlog = outDir === BLOG_ROOT || outDir.startsWith(BLOG_ROOT + sep);
  if (!insideBlog) {
    throw new Error(`拒绝清理 blog 目录之外的路径: ${outDir}`);
  }
  if (outDir === BLOG_ROOT) {
    throw new Error('输出目录不能是 blog 根目录本身');
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 一次性读全部，再分出草稿 —— 草稿不进站点产物
  const allPosts = loadPosts(postsDir, { includeDrafts: true });
  const posts = allPosts.filter((p) => !p.draft);
  const draftCount = allPosts.length - posts.length;
  const files = [];

  const write = (relPath, content) => {
    const full = join(outDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    files.push(relPath);
  };

  write('index.html', renderIndex(posts));

  for (const post of posts) {
    // p/<slug>/index.html —— 目录式布局让网址是不带 .html 的干净形式
    const relPath = `${'p'}/${post.slug}/index.html`;
    write(relPath.replace(/\//g, sep), renderPost(post, posts));
  }

  copyFileSync(STYLE_FILE, join(outDir, 'style.css'));
  files.push('style.css');

  // 图片资源：assets/images/ → dist/assets/images/
  const imagesSrc = join(BLOG_ROOT, 'assets', 'images');
  let imageCount = 0;
  if (existsSync(imagesSrc)) {
    for (const f of readdirSync(imagesSrc)) {
      const src = join(imagesSrc, f);
      if (!statSync(src).isFile()) continue;
      const dest = join(outDir, 'assets', 'images', f);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      files.push(`assets/images/${f}`);
      imageCount++;
    }
  }

  // GitHub Pages 默认跑 Jekyll；.nojekyll 让它跳过处理，直接原样发布
  writeFileSync(join(outDir, '.nojekyll'), '', 'utf8');
  files.push('.nojekyll');

  if (!opts.quiet) {
    console.log(`构建完成: ${outDir}`);
    console.log(`  文章 ${posts.length} 篇${draftCount ? `（另有 ${draftCount} 篇草稿未发布）` : ''}，图片 ${imageCount} 张，文件 ${files.length} 个`);
    for (const p of posts) console.log(`    p/${p.slug}/`);
  }

  return { outDir, count: posts.length, drafts: draftCount, images: imageCount, files };
}

/* CLI */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const outDir = i !== -1 ? resolve(args[i + 1]) : undefined;
  buildSite({ outDir });
}

// POST_DEPTH 目前固定为 2（p/<slug>/），这里做一次一致性自检，
// 以免以后调整目录结构时忘记同步模板里的相对路径层级。
if (POST_DEPTH !== 2) {
  throw new Error(`POST_DEPTH=${POST_DEPTH}，但构建布局固定为 p/<slug>/（两层），二者必须一致`);
}
