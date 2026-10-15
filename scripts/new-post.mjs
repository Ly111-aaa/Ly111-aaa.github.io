#!/usr/bin/env node
/**
 * 交互式新建文章：问一个标题，生成带 frontmatter 的 Markdown 并打开编辑器。
 *
 * 不需要懂任何语法 —— 由「新建文章.cmd」双击调用。
 * 也可以直接传标题：node scripts/new-post.mjs "我的标题"
 */

import { createInterface } from 'node:readline/promises';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = join(HERE, '..', 'posts');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const stampFile = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function slugify(s) {
  return (
    String(s)
      .trim()
      .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || '新文章'
  );
}

function openEditor(file) {
  // detached + stdio ignore：不占住窗口，也不依赖管道
  try {
    spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(POSTS_DIR, { recursive: true });

  let title = process.argv.slice(2).join(' ').trim();

  if (!title) {
    const rl = createInterface({ input: stdin, output: stdout });
    console.log('');
    console.log('  新建文章 —— 输入标题后回车（直接回车则取消）');
    console.log('');
    title = (await rl.question('  标题: ')).trim();
    rl.close();
    if (!title) {
      console.log('\n  已取消，没有创建任何文件。');
      return;
    }
  }

  const now = new Date();
  const slug = slugify(title);
  const file = join(POSTS_DIR, `${stampFile(now)}-${slug}.md`);

  if (existsSync(file)) {
    console.log(`\n  文件已存在，未覆盖: ${file}`);
    openEditor(file);
    return;
  }

  const content = `---
title: "${title.replace(/"/g, '\\"')}"
date: "${stamp(now)}"
category: "随笔"
tags: []
---

在这里写正文。支持 Markdown：

- 用 **两个星号** 表示粗体
- 用 \`反引号\` 表示行内代码
- 用 ## 表示小标题
- 空一行表示分段

写完后保存，然后双击「发布到线上.cmd」即可更新博客。
`;

  writeFileSync(file, content, 'utf8');

  console.log('');
  console.log('  已创建: ' + file);
  console.log('  文件名就是网址的一部分，可以随时改名。');
  console.log('');
  if (openEditor(file)) {
    console.log('  正在打开编辑器…… 写完后保存，再双击「发布到线上.cmd」。');
  } else {
    console.log('  没能自动打开编辑器，请手动打开上面这个文件。');
  }
  console.log('');
}

main();
