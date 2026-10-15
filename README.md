# 我的博客

一个**零依赖**的静态博客，带一个本地网页版编辑器。文章是 Markdown，存在 `posts/`，
推送到 GitHub 后由 GitHub Actions 自动发布到 <https://ly111-aaa.github.io/>。

**没有 `node_modules`，任何环节都不需要 `npm install`** —— 本地和 CI 都只依赖 Node.js（≥ 22）。

---

## 最常用：可视化编辑器（不用敲命令）

**双击 `start-blog.cmd`** —— 浏览器会自动打开编辑器：

```
http://127.0.0.1:5173/edit
```

在网页里：

- 左侧是文章列表，点一篇就能改
- 填**标题**和**正文**（正文用 Markdown，支持 `##` 小标题、`**粗体**`、`-` 列表、``` 代码块）
- 点 **保存** → 自动写成 Markdown 存进 `posts/`，本地立刻能看到效果
- 点 **预览** → 直接看渲染后的样子，不用保存
- 点 **发布到 GitHub** → 自动构建、提交、推送，约 1～2 分钟线上生效
  （需要点两次确认，防止误触）
- `Ctrl+S` 也能保存

分类和标签可选，留空也没问题。

---

## 本地预览博客成品

编辑器写的时候可以直接点右上角「查看博客」，或者访问：

```
http://127.0.0.1:5173/
```

> 服务器对外伺服的正是 `dist/` 里的构建产物 —— 也就是部署到 GitHub Pages 的
> **同一份 HTML**。所以本地看到什么，线上就是什么。

---

## 手写文章（不想用编辑器时）

在 `posts/` 下新建任意 `.md` 文件即可，文件名会成为网址的一部分
（`posts/hello.md` → `/p/hello/`）。可以完全不写 frontmatter ——
标题会自动用文件名，日期用文件修改时间。

想写得规范一点：

```markdown
---
title: "文章标题"
date: "2026-10-15 10:00:00"
category: "随笔"
tags: [dsh, 记录]
---

正文从这里开始……
```

首页按 `date` 倒序排列。

---

## 把 dsh 对话导出成文章

```bat
node scripts/export-session.mjs
```

自动找到最新一段 dsh 会话（**只读** `%USERPROFILE%\.dsh\sessions`），
只抽取纯对话正文（跳过内部思考、工具调用，以及 dsh 注入的运行上下文），
以当前时间命名写入 `posts/`。之后在编辑器里点「发布到 GitHub」即可。

| 命令 | 作用 |
| --- | --- |
| `node scripts/export-session.mjs` | 导出最新一段会话 |
| `node scripts/export-session.mjs --list` | 列出可导出的会话 |
| `node scripts/export-session.mjs --session <id>` | 导出指定会话 |
| `node scripts/export-session.mjs --title "标题"` | 覆盖文章标题 |

---

## 命令行方式（可选）

```bat
cd /d D:\project\dsh\blog
node server.mjs            :: 启动本地服务
node scripts/build-static.mjs   :: 只构建到 dist/
git add -A && git commit -m "..." && git push   :: 手动发布
```

端口被占用时会自动顺延到 5174、5175…，启动时打印实际地址。
指定端口：`node server.mjs --port 8080`。

---

## 部署原理

`.github/workflows/deploy.yml`：**推送到 `main` 就自动构建并发布**。

1. `actions/checkout` 拉代码
2. `actions/setup-node` 准备 Node 22
3. `node scripts/build-static.mjs` 生成 `dist/`（零依赖，几秒完成）
4. `actions/upload-pages-artifact` 上传 `dist/`
5. `actions/deploy-pages` 发布

发布成功后访问 <https://ly111-aaa.github.io/>，在 **Actions** 标签页可以看进度。

---

## 编辑器是怎么保护你的

本地服务能写文件、能推 GitHub，所以做了三层限制：

- **只监听 `127.0.0.1`**，局域网内其他机器访问不到
- **校验 `Host` 头**，只接受 `127.0.0.1` / `localhost`，挡 DNS rebinding 攻击
- **每次启动生成随机 token**，所有写操作都要带上；token 只内嵌在同源返回的
  编辑器页面里，外部网页拿不到

因此编辑器地址每次重启都有效（token 是服务端注入的），你只需要正常打开 `/edit` 即可。

---

## 目录结构

```
blog\
├─ posts\                      Markdown 文章（唯一的写作目录）
├─ assets\
│   ├─ style.css               站点样式（本地与线上共用）
│   └─ editor.html             可视化编辑器页面（只在本地用，不进站点产物）
├─ scripts\
│   ├─ site.mjs                页面模板、文章解析与序列化
│   ├─ build-static.mjs        构建静态站点 → dist/
│   ├─ markdown.mjs            零依赖 Markdown 渲染器
│   ├─ export-session.mjs      把 dsh 会话导出成文章
│   └─ new-post.mjs            命令行新建文章（编辑器之外的备选）
├─ .github\workflows\deploy.yml  自动部署到 GitHub Pages
├─ server.mjs                  本地服务器：站点 + 编辑器 API
├─ start-blog.cmd              双击启动（会直接打开编辑器）
├─ package.json                只有 npm scripts，没有任何依赖
└─ README.md
```

---

## 说明

- 所有链接都是**相对路径**，同一份 `dist/` 既能本地根路径预览，
  也能放在 GitHub Pages 子路径下，不必配置 base path。
- 文章内容全部做了 HTML 转义，Markdown 里的 `<tag>` 不会破坏页面。
- `dist/` 已加入 `.gitignore`，由 CI 构建，不入库。
- 导出脚本只**读取**会话日志，不会写入 `%USERPROFILE%\.dsh`。
