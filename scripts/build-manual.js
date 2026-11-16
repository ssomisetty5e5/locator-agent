// Builds docs/user-manual.html from docs/USER_MANUAL.md.
//
//   npm run build:manual
//
// A small, dependency-free converter for the Markdown subset the manual uses:
// headings, paragraphs, fenced code, tables, nested ordered/unordered lists
// (items may contain code blocks), block quotes, images, links, bold and
// inline code. The result is one self-contained HTML file: images are embedded,
// so it can be emailed or opened from anywhere.

const fs = require('fs');
const path = require('path');

const docsDir = path.resolve(__dirname, '..', 'docs');
const source = path.join(docsDir, 'USER_MANUAL.md');
const output = path.join(docsDir, 'user-manual.html');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub-style heading anchor, so the manual's own `[text](#anchors)` work in both formats. */
const slug = (text) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

function embedImage(src) {
  const file = path.resolve(docsDir, src);
  if (!fs.existsSync(file)) throw new Error(`Image not found: ${src}`);
  const type = mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** Inline formatting: code, images, links, bold. Input is raw text; output is HTML. */
function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${embedImage(src.replace(/&amp;/g, '&'))}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const isBlank = (l) => l.trim() === '';
const fenceOpen = (l) => /^\s*```(\w*)\s*$/.exec(l);
const listMarker = (l) => /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
const tableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const tableSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);

const headings = []; // { level, text, id } for the sidebar

/** Convert an array of lines to HTML blocks. */
function blocks(lines, top = false) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = fenceOpen(line);
    if (fence) {
      const indent = line.match(/^\s*/)[0].length;
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++].slice(Math.min(indent, lines[i - 1].match(/^\s*/)[0].length)));
      i++; // closing fence
      out.push(`<div class="code"><button class="copy" type="button">Copy</button><pre><code${fence[1] ? ` class="language-${fence[1]}"` : ''}>${esc(body.join('\n'))}</code></pre></div>`);
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const id = slug(h[2]);
      if (top && level >= 2) headings.push({ level, text: h[2], id });
      out.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^-{3,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (tableRow(line) && i + 1 < lines.length && tableSep(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && tableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${blocks(quote)}</blockquote>`);
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      const baseIndent = marker[1].length;
      const ordered = /\d/.test(marker[2]);
      const items = [];
      while (i < lines.length) {
        const m = listMarker(lines[i]);
        if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
        const contentIndent = baseIndent + m[2].length + 1;
        const body = [m[3]];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l)) {
            // a blank line belongs to the item only if more indented content follows
            let j = i;
            while (j < lines.length && isBlank(lines[j])) j++;
            if (j < lines.length && lines[j].match(/^\s*/)[0].length >= contentIndent) { body.push(''); i++; continue; }
            break;
          }
          if (l.match(/^\s*/)[0].length >= contentIndent) { body.push(l.slice(contentIndent)); i++; continue; }
          break;
        }
        items.push(body);
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((b) => `<li>${blocks(b).replace(/^<p>([\s\S]*?)<\/p>(?=$|\n<)/, '$1')}</li>`).join('')}</${tag}>`);
      continue;
    }

    // paragraph: runs until a blank line or the start of another block
    const para = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !fenceOpen(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !listMarker(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !(tableRow(lines[i]) && i + 1 < lines.length && tableSep(lines[i + 1]))
    ) para.push(lines[i++].trim());
    const text = para.join(' ');
    out.push(/^!\[[^\]]*\]\([^)]+\)$/.test(text) ? `<figure>${inline(text)}</figure>` : `<p>${inline(text)}</p>`);
  }
  return out.join('\n');
}

function template(title, version, nav, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#ffffff; --fg:#1f2433; --muted:#5b6178; --line:#e3e6f0; --accent:#4f58d6; --soft:#f4f5fb; --code:#f1f2f8; --note:#eef0ff; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg:#12141d; --fg:#e6e8f5; --muted:#9aa1c4; --line:#2a2e45; --accent:#8c94ff; --soft:#181b28; --code:#1c2033; --note:#1b2040; }
  }
  :root[data-theme="dark"] { --bg:#12141d; --fg:#e6e8f5; --muted:#9aa1c4; --line:#2a2e45; --accent:#8c94ff; --soft:#181b28; --code:#1c2033; --note:#1b2040; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 20px; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .layout { display:flex; max-width:1240px; margin:0 auto; }
  nav { position:sticky; top:0; align-self:flex-start; width:290px; height:100vh; overflow:auto; padding:28px 18px 28px 24px; border-right:1px solid var(--line); flex-shrink:0; }
  nav .brand { font-weight:700; font-size:1.05rem; color:var(--accent); margin-bottom:2px; }
  nav .ver { color:var(--muted); font-size:.85rem; margin-bottom:16px; }
  nav a { display:block; color:var(--muted); text-decoration:none; padding:4px 8px; border-radius:6px; font-size:.92rem; line-height:1.35; }
  nav a:hover { background:var(--soft); color:var(--fg); }
  nav a.active { color:var(--accent); background:var(--soft); font-weight:600; }
  nav a.sub { padding-left:22px; font-size:.86rem; }
  main { padding:36px 40px 80px; min-width:0; max-width:900px; flex:1; }
  h1 { font-size:2.1rem; line-height:1.2; margin:0 0 .3em; }
  h2 { font-size:1.55rem; margin:2.2em 0 .6em; padding-top:.6em; border-top:1px solid var(--line); }
  h3 { font-size:1.15rem; margin:1.8em 0 .5em; }
  p { margin:.8em 0; }
  a { color:var(--accent); }
  ul, ol { padding-left:1.5em; margin:.7em 0; } li { margin:.4em 0; } li > ol, li > ul { margin:.4em 0; }
  code { background:var(--code); border-radius:5px; padding:.12em .38em; font:.88em ui-monospace,SFMono-Regular,Consolas,monospace; }
  .code { position:relative; margin:1em 0; }
  pre { margin:0; background:var(--code); border:1px solid var(--line); border-radius:10px; padding:14px 16px; overflow:auto; }
  pre code { background:none; padding:0; font-size:.86em; line-height:1.55; }
  .copy { position:absolute; top:8px; right:8px; font:inherit; font-size:.75rem; background:var(--bg); color:var(--muted); border:1px solid var(--line); border-radius:6px; padding:2px 9px; cursor:pointer; opacity:.85; }
  .copy:hover { color:var(--fg); opacity:1; }
  .table { overflow-x:auto; margin:1em 0; }
  table { border-collapse:collapse; width:100%; font-size:.93rem; }
  th, td { text-align:left; padding:8px 12px; border:1px solid var(--line); vertical-align:top; }
  th { background:var(--soft); }
  blockquote { margin:1.1em 0; padding:.7em 1.1em; background:var(--note); border-left:4px solid var(--accent); border-radius:0 8px 8px 0; }
  blockquote p { margin:.3em 0; }
  figure { margin:1.3em 0; } figure img { max-width:100%; height:auto; border:1px solid var(--line); border-radius:10px; display:block; }
  hr { border:0; border-top:1px solid var(--line); margin:2em 0; }
  @media (max-width: 900px) { .layout { display:block; } nav { position:static; width:auto; height:auto; border-right:0; border-bottom:1px solid var(--line); } nav a.sub { display:none; } main { padding:24px 18px 60px; } }
  @media print { nav, .copy { display:none; } main { max-width:none; padding:0; } h2 { break-after:avoid; } pre, figure, table { break-inside:avoid; } }
</style>
</head>
<body>
<div class="layout">
<nav aria-label="Contents">
<div class="brand">LocatorAgent</div>
<div class="ver">User Manual · ${esc(version)}</div>
${nav}
</nav>
<main>
${body}
</main>
</div>
<script>
  document.querySelectorAll('.copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var text = b.parentElement.querySelector('code').textContent;
      var done = function (ok) { b.textContent = ok ? 'Copied' : 'Press Ctrl+C'; setTimeout(function () { b.textContent = 'Copy'; }, 1400); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });
  });
  var links = Array.prototype.slice.call(document.querySelectorAll('nav a'));
  var targets = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id); });
      });
    }, { rootMargin: '0px 0px -75% 0px' });
    targets.forEach(function (t) { if (t) io.observe(t); });
  }
</script>
</body>
</html>
`;
}

function build() {
  const md = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n').split('\n');

  // Drop the hand-written "Contents" list (the sidebar replaces it)
  const start = md.findIndex((l) => /^##\s+Contents\s*$/.test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < md.length && !/^##\s/.test(md[end])) end++;
    md.splice(start, end - start);
  }

  const versionLine = md.find((l) => /^Version\s+\S+/.test(l)) || '';
  const body = blocks(md, true);
  const title = (md.find((l) => /^#\s+/.test(l)) || '# User Manual').replace(/^#\s+/, '');
  const nav = headings
    .filter((h) => h.level <= 3)
    .map((h) => `<a href="#${h.id}"${h.level === 3 ? ' class="sub"' : ''}>${esc(h.text)}</a>`)
    .join('\n');

  fs.writeFileSync(output, template(title, versionLine.replace(/^Version\s+/, 'v'), nav, body));
  return { output, bytes: fs.statSync(output).size, sections: headings.length };
}

module.exports = { build };

if (require.main === module) {
  const { output: out, bytes, sections } = build();
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${(bytes / 1024).toFixed(0)} KB, ${sections} sections)`);
}
