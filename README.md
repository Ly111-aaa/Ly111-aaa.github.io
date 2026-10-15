# 我的博客

一个**零依赖**的静态博客：Markdown 文章放在 `posts/`，用 Node 内置模块构建成
静态站点，推送到 GitHub 后由 GitHub Actions 自动发布到 GitHub Pages。

**没有 `node_modules`，任何环节都不需要 `npm install`** —— 本地和 CI 都只依赖 Node.js（≥ 22）。

---

## 本地预览

```bat
cd /d D:\project\dsh\blog
node server.mjs
```

打开 <http://127.0.0.1:5173>。

> 服务器对外伺服的正是 `dist/` 里的构建产物 —— 也就是将来部署到 GitHub Pages 的
> **同一份 HTML**。所以本地看到什么，线上就是什么。
> 改完 `posts/` 里的文章刷新浏览器即可，服务器会自动重建。

双击 `start-blog.cmd` 也可以。

---

## 写文章

在 `posts/` 下新建任意 `.md` 文件，文件名会成为网址的一部分
（`posts/hello.md` → `/p/hello/`）。可选的 frontmatter：

```markdown
---
title: "文章标题"
date: "2026-10-15 10:00:00"
category: "随笔"
tags: [dsh, 记录]
---

正文从这里开始……
```

`title` / `date` 缺省时分别退回文件名和文件修改时间。首页按 `date` 倒序排列。

---

## 把 dsh 对话导出成文章

```bat
node scripts/export-session.mjs
```

自动找到最新一段 dsh 会话（**只读** `%USERPROFILE%\.dsh\sessions`），
只抽取纯对话正文（跳过内部思考、工具调用，以及 dsh 注入的运行上下文），
以当前时间命名写入 `posts/`。

| 命令 | 作用 |
| --- | --- |
| `node scripts/export-session.mjs` | 导出最新一段会话 |
| `node scripts/export-session.mjs --list` | 列出可导出的会话 |
| `node scripts/export-session.mjs --session <id>` | 导出指定会话 |
| `node scripts/export-session.mjs --title "标题"` | 覆盖文章标题 |
| `node scripts/export-session.mjs --reasoning` | 连思考过程一起导出 |

---

## 手动构建

```bat
node scripts/build-static.mjs
```

产物在 `dist/`。用 `--out <目录>` 可以换个输出位置。

---

## 部署到 GitHub Pages

仓库里已经配好 `.github/workflows/deploy.yml`：**推送到 `main` 就自动构建并发布**。

流程是：

1. `actions/checkout` 拉代码
2. `actions/setup-node` 准备 Node 22
3. `node scripts/build-static.mjs` 生成 `dist/`（零依赖，几秒完成）
4. `actions/upload-pages-artifact` 上传 `dist/`
5. `actions/deploy-pages` 发布

### 首次配置

1. 在 GitHub 上建一个空仓库（**不要**勾选自动生成 README，否则推送会冲突）
2. 到仓库 **Settings → Pages → Source** 选择 **GitHub Actions**
   （工作流里带了 `enablement: true`，多数情况下会自动设置；若没生效就手动选一次）
3. 推送代码后，在 **Actions** 标签页看部署进度
4. 发布成功后访问 `https://<用户名>.github.io/<仓库名>/`

> 如果仓库名就是 `<用户名>.github.io`，则访问 `https://<用户名>.github.io/`，
> 不需要子路径。本站点用相对链接，两种情形都能正常工作。

### 日常更新

```bat
git add -A
git commit -m "新文章"
git push
```

推上去之后 Actions 会自动重新发布，通常一两分钟生效。

---

## 目录结构

```
blog\
├─ posts\                      Markdown 文章（唯一的写作目录）
├─ assets\style.css            样式（本地与线上共用同一份）
├─ scripts\
│   ├─ site.mjs                页面模板与文章加载
│   ├─ build-static.mjs        构建静态站点 → dist/
│   ├─ markdown.mjs            零依赖 Markdown 渲染器
│   └─ export-session.mjs      把 dsh 会话导出成文章
├─ .github\workflows\deploy.yml  自动部署到 GitHub Pages
├─ server.mjs                  本地预览服务器
├─ start-blog.cmd              双击启动本地预览
├─ package.json                只有 npm scripts，没有任何依赖
└─ README.md
```

---

## 说明

- 所有链接都是**相对路径**，因此同一份 `dist/` 既能在本地根路径预览，
  也能放在 GitHub Pages 的项目子路径下，不必配置 base path。
- 文章内容全部做了 HTML 转义，Markdown 里的 `<tag>` 不会破坏页面。
- `dist/` 已加入 `.gitignore`，由 CI 构建，不入库。
- 导出脚本只**读取**会话日志，不会写入 `%USERPROFILE%\.dsh`。
