/**
 * 零依赖 Markdown 渲染器 + frontmatter 解析。
 *
 * 只实现博客导出实际用得到的子集，但每一处都做了 HTML 转义，
 * 避免文章里的 <tag> 或 & 破坏页面结构。
 *
 * 支持：ATX 标题、段落、围栏代码块、引用、有序/无序列表（含嵌套）、
 *       表格、水平线、行内 code/粗体/斜体/删除线/链接/图片/自动链接。
 */

const CODE_SLOT = '\u0000';

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* frontmatter                                                         */
/* ------------------------------------------------------------------ */

/**
 * 解析 `---` 包裹的 frontmatter。只支持 `key: value` 与 `key: [a, b]`，
 * 足够覆盖本博客自己写出的文件，同时也能容忍手写的简单 YAML。
 */
export function parseFrontmatter(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, content: text };

  const data = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
    } else {
      data[key] = stripQuotes(value);
    }
  }
  return { data, content: text.slice(m[0].length) };
}

function stripQuotes(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* inline                                                              */
/* ------------------------------------------------------------------ */

function renderInline(raw) {
  // 先整体转义，再做行内标记替换，保证任何原始 HTML 都不会穿透。
  let out = escapeHtml(raw);

  // 行内 code 先摘出来，避免其中的 * _ [ ] 被当成标记。
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `${CODE_SLOT}${codes.length - 1}${CODE_SLOT}`;
  });

  // 图片要先于链接处理。
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_m, alt, src, title) =>
      `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`,
  );

  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_m, label, href, title) =>
      `<a href="${href}"${title ? ` title="${title}"` : ''}>${label}</a>`,
  );

  // 裸 URL 自动链接（跳过已经在 <a href> 里的情况）。
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g, (_m, pre, url) => {
    if (pre.includes('<a ')) return _m;
    return `${pre}<a href="${url}">${url}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  out = out.replace(
    new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, 'g'),
    (_m, idx) => `<code>${codes[Number(idx)]}</code>`,
  );

  return out;
}

/* ------------------------------------------------------------------ */
/* block                                                               */
/* ------------------------------------------------------------------ */

const RE_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RE_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^`\s]*)[ \t]*$/;
const RE_HR = /^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_QUOTE = /^[ \t]*>[ \t]?(.*)$/;
const RE_UL = /^([ \t]*)[-*+][ \t]+(.*)$/;
const RE_OL = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const RE_TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function renderList(items) {
  // items: [{ indent, ordered, text }]
  // 关键点：子列表必须嵌在上一个 <li> 内部，且 <li> 延迟闭合，
  // 否则会生成 <ul><li>a</li><ul>…</ul></ul> 这种非法结构。
  let html = '';
  const stack = []; // { indent, ordered, liOpen }

  const openList = (indent, ordered) => {
    html += ordered ? '<ol>' : '<ul>';
    stack.push({ indent, ordered, liOpen: false });
  };
  const closeList = () => {
    const top = stack.pop();
    if (top.liOpen) html += '</li>';
    html += top.ordered ? '</ol>' : '</ul>';
  };

  for (const item of items) {
    while (stack.length && item.indent < stack[stack.length - 1].indent) closeList();

    if (!stack.length) {
      openList(item.indent, item.ordered);
    } else {
      const top = stack[stack.length - 1];
      if (item.indent > top.indent) {
        openList(item.indent, item.ordered);
      } else if (top.ordered !== item.ordered) {
        // 同层由 ul 切到 ol（或反过来）时重开列表。
        closeList();
        openList(item.indent, item.ordered);
      } else if (top.liOpen) {
        html += '</li>';
      }
    }

    const cur = stack[stack.length - 1];
    html += `<li>${renderInline(item.text)}`;
    cur.liOpen = true;
  }

  while (stack.length) closeList();
  return html;
}

export function renderMarkdown(raw) {
  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let i = 0;

  const flush = () => {
    if (!para.length) return;
    // 段落内的软换行保留成 <br>，导出聊天记录时可读性更好。
    out.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = RE_FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const body = [];
      i++;
      while (i < lines.length) {
        const close = RE_FENCE.exec(lines[i]);
        if (close && close[1][0] === marker && !close[2]) break;
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾围栏
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    // 标题
    const h = RE_HEADING.exec(line);
    if (h) {
      flush();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // 水平线
    if (RE_HR.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let t = '<div class="table-wrap"><table><thead><tr>';
      for (const c of head) t += `<th>${renderInline(c)}</th>`;
      t += '</tr></thead><tbody>';
      for (const r of rows) {
        t += '<tr>';
        for (let k = 0; k < head.length; k++) t += `<td>${renderInline(r[k] ?? '')}</td>`;
        t += '</tr>';
      }
      t += '</tbody></table></div>';
      out.push(t);
      continue;
    }

    // 引用（连续行合并）
    if (RE_QUOTE.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(RE_QUOTE.exec(lines[i])[1]);
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表（连续收集，含缩进嵌套）
    if (RE_UL.test(line) || RE_OL.test(line)) {
      flush();
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const ul = RE_UL.exec(cur);
        const ol = RE_OL.exec(cur);
        if (ul) {
          items.push({ indent: ul[1].replace(/\t/g, '    ').length, ordered: false, text: ul[2] });
        } else if (ol) {
          items.push({ indent: ol[1].replace(/\t/g, '    ').length, ordered: true, text: ol[3] });
        } else if (cur.trim() && items.length && /^[ \t]{2,}\S/.test(cur)) {
          // 续行：并进上一条
          items[items.length - 1].text += ' ' + cur.trim();
        } else {
          break;
        }
        i++;
      }
      out.push(renderList(items));
      continue;
    }

    // 普通段落
    para.push(line);
    i++;
  }

  flush();
  return out.join('\n');
}
