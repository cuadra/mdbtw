(() => {
  'use strict';

  const INIT = window.__MDR_INIT__ || {};
  const bridge = window.webkit?.messageHandlers?.mdr;
  const NONCE = document.currentScript?.nonce || '';
  const content = document.getElementById('content');
  const root = document.scrollingElement || document.documentElement;

  const BAR_H = 26;
  const LINE = 56; // px per j/k
  const TOP_PAD = 12; // gap kept above a jump target
  const HINT_CHARS = 'asdfghjkl';
  const MAX_MATCHES = 10000;
  const BLOCKS = 'p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,dt,dd,summary,figcaption,div,section';

  // ---------------------------------------------------------------- bridge

  function post(type, data) {
    if (!bridge) return false;
    // Every message carries the scroll position so the host can restore it.
    bridge.postMessage(JSON.stringify({ type, y: window.scrollY, ...data }));
    return true;
  }

  function yank(text, what) {
    if (!text) return flash('Nothing to yank', true);
    if (!post('yank', { text })) navigator.clipboard?.writeText(text).catch(() => {});
    const lines = text.split('\n').length;
    flash(`Yanked ${what || (lines > 1 ? `${lines} lines` : `${text.length} chars`)}`);
  }

  // ---------------------------------------------------------------- chrome

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  }

  const modeEl = el('span', { id: 'mdr-mode' }, 'NORMAL');
  const promptEl = el('span');
  const inputEl = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
  const cmdEl = el('span', { id: 'mdr-cmd' }, promptEl, inputEl);
  const msgEl = el('span', { id: 'mdr-msg' });
  const keysEl = el('span', { id: 'mdr-keys' });
  const countEl = el('span');
  const nameEl = el('span', { id: 'mdr-name' }, INIT.name || '');
  const posEl = el('span');
  const bar = el('div', { id: 'mdr-bar', 'data-mdr-ui': '' }, modeEl, cmdEl, msgEl, keysEl, countEl, nameEl, posEl);
  const hintsEl = el('div', { id: 'mdr-hints', 'data-mdr-ui': '' });
  const panelTitle = el('header');
  const panelBody = el('div', { class: 'body' });
  const panel = el('div', { id: 'mdr-panel', 'data-mdr-ui': '' }, panelTitle, panelBody);
  document.body.append(hintsEl, panel, bar);

  let mode = 'normal';
  const MODE_LABEL = { normal: 'NORMAL', visual: 'VISUAL', vline: 'V-LINE', hint: 'HINT', cmd: 'COMMAND', panel: 'NORMAL' };

  function setMode(m) {
    mode = m;
    modeEl.textContent = MODE_LABEL[m];
    modeEl.dataset.mode = m;
  }

  let flashTimer = 0;
  function flash(text, isError) {
    msgEl.textContent = text;
    msgEl.classList.toggle('error', !!isError);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (msgEl.textContent = ''), 4000);
  }

  // ---------------------------------------------------------------- scrolling

  const maxY = () => Math.max(0, root.scrollHeight - window.innerHeight);
  const viewH = () => window.innerHeight - BAR_H;
  const absTop = (node) => node.getBoundingClientRect().top + window.scrollY;

  function scrollToY(y) {
    window.scrollTo(window.scrollX, Math.max(0, Math.min(y, maxY())));
  }

  // Jump list (C-o / C-i) and the '' mark.
  const jumps = [];
  let jumpIdx = 0;
  let prevPos = 0;

  function pushJump(from = window.scrollY) {
    jumps.length = jumpIdx;
    if (jumps[jumps.length - 1] !== from) jumps.push(from);
    jumpIdx = jumps.length;
    prevPos = from;
  }

  function jump(y) {
    pushJump();
    scrollToY(y);
  }

  function jumpBack() {
    if (jumpIdx === 0) {
      if (!post('back', {})) flash('At oldest position');
      return;
    }
    if (jumpIdx === jumps.length) jumps.push(window.scrollY);
    scrollToY(jumps[--jumpIdx]);
  }

  function jumpForward() {
    if (jumpIdx >= jumps.length - 1) {
      if (!post('forward', {})) flash('At newest position');
      return;
    }
    scrollToY(jumps[++jumpIdx]);
  }

  function updatePos() {
    const max = maxY();
    const y = window.scrollY;
    posEl.textContent = max <= 0 ? 'All' : y <= 0 ? 'Top' : y >= max - 1 ? 'Bot' : `${Math.round((y / max) * 100)}%`;
  }

  let reportTimer = 0;
  window.addEventListener('scroll', () => {
    updatePos();
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => post('scroll', { y: window.scrollY }), 120);
  }, { passive: true });
  window.addEventListener('resize', updatePos);

  // ---------------------------------------------------------------- structure

  const headings = () => [...content.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const blocks = () => [...content.children];

  // Move to the n-th element start below (dir 1) or above (dir -1) the top edge.
  function stepTo(list, dir, n) {
    const tops = list.map(absTop);
    const here = window.scrollY + TOP_PAD;
    let i;
    if (dir > 0) {
      i = tops.findIndex((t) => t > here + 1);
      if (i < 0) return;
      i = Math.min(tops.length - 1, i + n - 1);
    } else {
      i = tops.findLastIndex((t) => t < here - 1);
      if (i < 0) return jump(0);
      i = Math.max(0, i - n + 1);
    }
    jump(tops[i] - TOP_PAD);
  }

  function openAncestors(node) {
    const start = node.nodeType === 1 ? node : node.parentElement;
    for (let d = start?.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) {
      d.open = true;
    }
  }

  function gotoFragment(raw, record = true) {
    let id = raw;
    try { id = decodeURIComponent(raw); } catch { /* keep raw */ }
    const target = document.getElementById(id) || document.getElementsByName(id)[0];
    if (!target) return flash(`No such anchor: #${id}`, true);
    openAncestors(target);
    const y = absTop(target) - TOP_PAD;
    if (record) jump(y); else scrollToY(y);
  }

  // Source line -> rendered element, via comrak's data-sourcepos.
  function gotoLine(n) {
    let best = null;
    let bestLine = 0;
    for (const node of content.querySelectorAll('[data-sourcepos]')) {
      const line = parseInt(node.dataset.sourcepos, 10);
      if (line <= n && line > bestLine) {
        best = node;
        bestLine = line;
      }
    }
    if (!best) return jump(0);
    openAncestors(best);
    jump(absTop(best) - TOP_PAD);
  }

  // ---------------------------------------------------------------- links

  function followLink(a) {
    const raw = a.getAttribute('href') || '';
    if (raw.startsWith('#')) return gotoFragment(raw.slice(1));
    if (!post('open', { href: a.href })) location.assign(a.href);
  }

  function onLinkClick(e) {
    const a = e.target.closest?.('a[href]');
    if (!a || a.closest('[data-mdr-ui]')) return;
    e.preventDefault();
    if (e.type === 'click' || e.button === 1) followLink(a);
  }
  document.addEventListener('click', onLinkClick);
  document.addEventListener('auxclick', onLinkClick);

  // ---------------------------------------------------------------- search

  const canHighlight = typeof Highlight !== 'undefined' && !!CSS.highlights;
  const search = { pattern: '', backward: false, ranges: [], cur: -1 };

  // All readable text as one string, with a newline wherever the enclosing
  // block changes so a match can span inline markup but not paragraphs.
  let indexCache = null;
  new MutationObserver(() => (indexCache = null))
    .observe(content, { childList: true, subtree: true, characterData: true });

  function buildIndex() {
    if (indexCache) return indexCache;
    const nodes = [];
    const starts = [];
    let text = '';
    let lastBlock = null;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        return !p || p.closest('annotation,script,style,[data-mdr-ui]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node; (node = walker.nextNode());) {
      const block = node.parentElement.closest(BLOCKS) || content;
      if (block !== lastBlock) {
        text += '\n';
        lastBlock = block;
      }
      starts.push(text.length);
      nodes.push(node);
      text += node.data;
    }
    indexCache = { text, lower: null, nodes, starts };
    return indexCache;
  }

  function nodeAt(index, pos) {
    let lo = 0;
    let hi = index.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (index.starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function findRanges(pattern) {
    const index = buildIndex();
    let hay = index.text;
    let needle = pattern;
    if (!/[A-Z]/.test(pattern)) { // smartcase
      index.lower ??= hay.toLowerCase();
      if (index.lower.length === hay.length) {
        hay = index.lower;
        needle = pattern.toLowerCase();
      }
    }
    const ranges = [];
    if (!needle || !index.nodes.length) return ranges;
    for (let at = hay.indexOf(needle); at >= 0 && ranges.length < MAX_MATCHES; at = hay.indexOf(needle, at + needle.length)) {
      const end = at + needle.length;
      const s = nodeAt(index, at);
      const e = nodeAt(index, end - 1);
      const range = document.createRange();
      range.setStart(index.nodes[s], Math.min(at - index.starts[s], index.nodes[s].length));
      range.setEnd(index.nodes[e], Math.min(end - index.starts[e], index.nodes[e].length));
      ranges.push(range);
    }
    return ranges;
  }

  function rangeRect(range) {
    const rects = range.getClientRects();
    if (rects.length) return rects[0];
    let node = range.startContainer.parentElement;
    while (node && !node.getClientRects().length) node = node.parentElement;
    return node ? node.getBoundingClientRect() : null;
  }

  // Index of the first match at or below y (document order is top-to-bottom).
  function firstMatchFrom(y) {
    const { ranges } = search;
    let lo = 0;
    let hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const rect = rangeRect(ranges[mid]);
      if (rect && rect.top + window.scrollY >= y) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  function paintSearch() {
    countEl.textContent = search.ranges.length ? `[${search.cur + 1}/${search.ranges.length}]` : '';
    if (!canHighlight) {
      const sel = getSelection();
      sel.removeAllRanges();
      if (search.ranges[search.cur]) sel.addRange(search.ranges[search.cur].cloneRange());
      return;
    }
    CSS.highlights.delete('mdr-search');
    CSS.highlights.delete('mdr-current');
    if (!search.ranges.length) return;
    CSS.highlights.set('mdr-search', new Highlight(...search.ranges));
    const current = new Highlight(search.ranges[search.cur]);
    current.priority = 1;
    CSS.highlights.set('mdr-current', current);
  }

  function showMatch(i) {
    search.cur = i;
    const range = search.ranges[i];
    openAncestors(range.startContainer);
    const rect = rangeRect(range);
    if (rect && (rect.top < TOP_PAD || rect.bottom > viewH() - TOP_PAD)) {
      scrollToY(rect.top + window.scrollY - viewH() / 2);
    }
    paintSearch();
  }

  function runSearch(pattern, backward, fromY) {
    search.pattern = pattern;
    search.backward = backward;
    search.ranges = findRanges(pattern);
    search.cur = -1;
    const total = search.ranges.length;
    if (!total) {
      paintSearch();
      return false;
    }
    let i = firstMatchFrom(fromY);
    if (backward) i = (i - 1 + total) % total; else i %= total;
    showMatch(i);
    return true;
  }

  function searchNext(n, reverse) {
    if (!search.pattern) return flash('No previous search', true);
    if (!search.ranges.length && !runSearch(search.pattern, search.backward, window.scrollY)) {
      return flash(`Pattern not found: ${search.pattern}`, true);
    }
    const total = search.ranges.length;
    const dir = search.backward !== reverse ? -1 : 1;
    pushJump();
    showMatch((((search.cur + dir * n) % total) + total) % total);
  }

  function clearSearch() {
    search.ranges = [];
    search.cur = -1;
    paintSearch();
  }

  // ---------------------------------------------------------------- prompt

  let promptKind = '';
  let promptOrigin = 0;

  function openPrompt(kind, preset = '') {
    promptKind = kind;
    promptOrigin = window.scrollY;
    promptEl.textContent = kind;
    inputEl.value = preset;
    bar.classList.add('prompt');
    setMode('cmd');
    inputEl.focus();
  }

  function closePrompt() {
    bar.classList.remove('prompt');
    inputEl.blur();
    setMode('normal');
  }

  inputEl.addEventListener('input', () => {
    if (promptKind === ':') return;
    if (!inputEl.value || !runSearch(inputEl.value, promptKind === '?', promptOrigin)) {
      clearSearch();
      scrollToY(promptOrigin);
    }
  });

  function commitPrompt() {
    const value = inputEl.value;
    const kind = promptKind;
    closePrompt();
    if (kind === ':') return runCommand(value.trim());
    const pattern = value || search.pattern;
    if (!pattern) return;
    if (runSearch(pattern, kind === '?', promptOrigin)) {
      if (window.scrollY !== promptOrigin) pushJump(promptOrigin);
    } else {
      scrollToY(promptOrigin);
      flash(`Pattern not found: ${pattern}`, true);
    }
  }

  function cancelPrompt() {
    const wasSearch = promptKind !== ':';
    closePrompt();
    if (wasSearch) {
      clearSearch();
      scrollToY(promptOrigin);
    }
  }

  function runCommand(line) {
    if (!line) return;
    if (/^\d+$/.test(line)) return gotoLine(parseInt(line, 10));
    const [name, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case 'q': case 'q!': case 'quit': case 'x': case 'wq':
        return post('quit', {});
      case 'e': case 'edit': case 'o': case 'open':
        return arg ? post('edit', { path: arg }) : post('reload', {});
      case 'r': case 'reload':
        return post('reload', {});
      case 'noh': case 'nohlsearch':
        return clearSearch();
      case 'toc': case 'outline':
        return openToc();
      case 'h': case 'help':
        return openHelp();
      case 'theme':
        if (!['auto', 'dark', 'light'].includes(arg)) return flash('Usage: :theme auto|dark|light', true);
        return setTheme(arg, true);
      default:
        flash(`Not a command: ${name}`, true);
    }
  }

  // ---------------------------------------------------------------- theme

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let theme = INIT.theme || 'auto';

  function setTheme(value, persist) {
    theme = value;
    const resolved = value === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : value;
    document.documentElement.dataset.theme = resolved;
    if (persist) {
      post('theme', { value });
      flash(`Theme: ${value}`);
    }
  }
  darkQuery.addEventListener('change', () => theme === 'auto' && setTheme('auto', false));

  // ---------------------------------------------------------------- hints

  let hints = [];
  let hintTyped = '';
  let hintAction = null;

  function visibleRect(node) {
    for (const rect of node.getClientRects()) {
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewH() &&
          rect.right > 0 && rect.left < window.innerWidth) return rect;
    }
    return null;
  }

  function startHints(selector, action, label) {
    const targets = [];
    for (const node of content.querySelectorAll(selector)) {
      const rect = visibleRect(node);
      if (rect) targets.push({ node, rect });
    }
    if (!targets.length) return flash(`No ${label} in view`, true);

    const base = HINT_CHARS.length;
    let width = 1;
    while (base ** width < targets.length) width++;
    hints = targets.map(({ node, rect }, i) => {
      let text = '';
      for (let k = 0, v = i; k < width; k++, v = Math.floor(v / base)) text = HINT_CHARS[v % base] + text;
      const tag = el('div', { class: 'mdr-hint' });
      tag.style.left = `${Math.max(0, rect.left - 4)}px`;
      tag.style.top = `${Math.max(0, rect.top - 2)}px`;
      hintsEl.append(tag);
      return { node, text, tag };
    });
    hintTyped = '';
    hintAction = action;
    paintHints();
    setMode('hint');
  }

  function paintHints() {
    for (const h of hints) {
      const match = h.text.startsWith(hintTyped);
      h.tag.style.display = match ? '' : 'none';
      if (match) h.tag.replaceChildren(el('span', { class: 'typed' }, hintTyped), h.text.slice(hintTyped.length));
    }
  }

  function endHints() {
    hintsEl.replaceChildren();
    hints = [];
    setMode('normal');
  }

  function onHintKey(k) {
    if (k === 'Backspace') {
      hintTyped = hintTyped.slice(0, -1);
      paintHints();
    } else if (k.length === 1 && HINT_CHARS.includes(k.toLowerCase())) {
      hintTyped += k.toLowerCase();
      const hit = hints.find((h) => h.text === hintTyped);
      if (hit) {
        const action = hintAction;
        endHints();
        action(hit.node);
      } else if (!hints.some((h) => h.text.startsWith(hintTyped))) {
        endHints();
      } else {
        paintHints();
      }
    } else {
      endHints();
    }
    return true;
  }

  function activate(node) {
    if (node.matches('a[href]')) followLink(node);
    else if (node.matches('video,audio')) node.paused ? node.play().catch(() => {}) : node.pause();
    else if (node.matches('summary')) node.parentElement.open = !node.parentElement.open;
  }

  const LINKS = 'a[href]:not(.anchor)';
  const followHints = () => startHints(`${LINKS},video,audio,summary`, activate, 'links');
  const yankLinkHints = () => startHints(LINKS, (a) => {
    const raw = a.getAttribute('href');
    yank(raw.startsWith('#') ? raw : a.href, 'link');
  }, 'links');
  const yankCodeHints = () => startHints('pre:not(.mermaid)', (pre) => {
    yank(pre.innerText.replace(/\n$/, ''), 'code block');
  }, 'code blocks');

  // ---------------------------------------------------------------- panels (outline, help)

  let panelItems = [];
  let panelSel = 0;
  let panelPick = null;

  function openPanel(title, nodes, items, pick, selected = 0) {
    panelTitle.textContent = title;
    panelBody.replaceChildren(...nodes);
    panelItems = items;
    panelPick = pick;
    panel.classList.add('open');
    panelBody.scrollTop = 0;
    setMode('panel');
    selectItem(selected);
  }

  function closePanel() {
    panel.classList.remove('open');
    panelItems = [];
    setMode('normal');
  }

  function selectItem(i) {
    if (!panelItems.length) return;
    panelItems[panelSel]?.classList.remove('sel');
    panelSel = Math.max(0, Math.min(i, panelItems.length - 1));
    panelItems[panelSel].classList.add('sel');
    panelItems[panelSel].scrollIntoView({ block: 'nearest' });
  }

  function onPanelKey(k) {
    const page = Math.max(1, Math.floor(panelBody.clientHeight / 56));
    const move = (d) => (panelItems.length ? selectItem(panelSel + d) : panelBody.scrollBy(0, d * 28));
    switch (k) {
      case 'j': case 'ArrowDown': case 'C-n': move(1); break;
      case 'k': case 'ArrowUp': case 'C-p': move(-1); break;
      case 'd': case 'C-d': move(page); break;
      case 'u': case 'C-u': move(-page); break;
      case 'g': panelItems.length ? selectItem(0) : (panelBody.scrollTop = 0); break;
      case 'G': panelItems.length ? selectItem(panelItems.length - 1) : (panelBody.scrollTop = panelBody.scrollHeight); break;
      case 'Enter': case 'l': case 'o':
        if (panelItems.length) {
          const i = panelSel;
          const pick = panelPick;
          closePanel();
          pick(i);
        }
        break;
      default: closePanel();
    }
    return true;
  }

  function openToc() {
    const list = headings();
    if (!list.length) return flash('No headings', true);
    const minLevel = Math.min(...list.map((h) => +h.tagName[1]));
    const here = window.scrollY + TOP_PAD + 1;
    let current = 0;
    const rows = list.map((h, i) => {
      if (absTop(h) <= here) current = i;
      const row = el('div', { class: 'item' }, h.textContent.trim() || '(untitled)');
      row.style.paddingLeft = `${10 + (+h.tagName[1] - minLevel) * 18}px`;
      row.addEventListener('click', () => {
        closePanel();
        jump(absTop(h) - TOP_PAD);
      });
      return row;
    });
    openPanel('Outline', rows, rows, (i) => jump(absTop(list[i]) - TOP_PAD), current);
  }

  const HELP = [
    ['Scrolling'],
    ['j / k', 'Scroll down / up (takes a count: 5j)'],
    ['d / u, Ctrl-d / Ctrl-u', 'Half page down / up'],
    ['Ctrl-f / Ctrl-b, Space', 'Full page down / up'],
    ['gg / G', 'Top / bottom'],
    ['{n}G, :{n}', 'Go to source line n'],
    ['{n}%', 'Go to n percent of the document'],
    ['h / l', 'Scroll left / right'],
    ['Jumping'],
    [']] / [[', 'Next / previous heading'],
    ['} / {', 'Next / previous block'],
    ['gO or t', 'Outline (j/k, Enter)'],
    ['Ctrl-o / Ctrl-i', 'Back / forward through jumps and opened files'],
    ['H / L', 'Previous / next file'],
    ["m{a-z}, '{a-z}", 'Set mark, jump to mark'],
    ["''", 'Jump back to where you were'],
    ['Search'],
    ['/ and ?', 'Search forward / backward (smartcase, live)'],
    ['n / N', 'Next / previous match'],
    ['Esc, :noh', 'Clear highlights'],
    ['Links'],
    ['f', 'Hint links, videos and <details>; type the label to open'],
    ['yf', 'Hint links; copy the URL'],
    ['mouse click', 'Open a link'],
    ['Copying'],
    ['v / V', 'Visual / line-visual mode (starts at a search match, a click, or the top line)'],
    ['h j k l w b e 0 $ { } gg G', 'Extend the selection (visual mode)'],
    ['o', 'Swap selection ends (visual mode)'],
    ['y', 'Yank the selection (also works on a mouse selection)'],
    ['yc', 'Hint code blocks; copy one'],
    ['yy', 'Copy the markdown source'],
    ['yp', 'Copy the file path'],
    ['View'],
    ['+ / - / =', 'Zoom in / out / reset'],
    ['gt, :theme auto|dark|light', 'Toggle / set theme'],
    ['r, :e', 'Reload (files also reload when they change on disk)'],
    [':e {file}', 'Open another file'],
    ['q, ZZ, :q', 'Quit'],
    ['g? or F1', 'This help'],
  ];

  function openHelp() {
    const table = el('table');
    for (const [keys, text] of HELP) {
      const row = text === undefined
        ? el('tr', { class: 'section' }, el('td', { colspan: '2' }, keys))
        : el('tr', {}, el('td', {}, keys), el('td', {}, text));
      table.append(row);
    }
    openPanel('Keys  (j/k to scroll, any other key closes)', [table], [], null);
  }

  // ---------------------------------------------------------------- visual mode

  const VISUAL_MOTIONS = {
    h: ['backward', 'character'], l: ['forward', 'character'],
    j: ['forward', 'line'], k: ['backward', 'line'],
    w: ['forward', 'word'], e: ['forward', 'word'], b: ['backward', 'word'],
    0: ['backward', 'lineboundary'], '^': ['backward', 'lineboundary'], $: ['forward', 'lineboundary'],
    '}': ['forward', 'paragraph'], '{': ['backward', 'paragraph'],
    ArrowLeft: ['backward', 'character'], ArrowRight: ['forward', 'character'],
    ArrowDown: ['forward', 'line'], ArrowUp: ['backward', 'line'],
  };

  // Line-visual state: the anchor line's two ends and the un-snapped focus.
  let lineAnchor = null;
  let lineFocus = null;

  const point = (node, offset) => ({ node, offset });

  // <0 when a is before b in the document, >0 when after.
  function comparePoints(a, b) {
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.collapse(true);
    return -range.comparePoint(b.node, b.offset);
  }

  function caretAt(x, y) {
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      return range && point(range.startContainer, range.startOffset);
    }
    const pos = document.caretPositionFromPoint?.(x, y);
    return pos && point(pos.offsetNode, pos.offset);
  }

  function inView(p) {
    const range = document.createRange();
    range.setStart(p.node, p.offset);
    range.collapse(true);
    const rect = rangeRect(range);
    return !!rect && rect.bottom > 0 && rect.top < viewH();
  }

  function firstVisibleText() {
    const box = content.getBoundingClientRect();
    for (let y = 6; y < viewH(); y += 6) {
      for (const x of [box.left + 6, box.left + 48, box.left + box.width / 2]) {
        const p = caretAt(x, y);
        if (p && p.node.nodeType === 3 && content.contains(p.node) && p.node.data.trim()) return p;
      }
    }
    return null;
  }

  function enterVisual(linewise) {
    const sel = getSelection();
    const inContent = sel.rangeCount && content.contains(sel.anchorNode);
    if (!(inContent && !sel.isCollapsed)) {
      let start = null;
      const match = search.ranges[search.cur];
      if (inContent && inView(point(sel.anchorNode, sel.anchorOffset))) {
        start = point(sel.anchorNode, sel.anchorOffset); // caret left by a mouse click
      } else if (match && inView(point(match.startContainer, match.startOffset))) {
        start = point(match.startContainer, match.startOffset);
      } else {
        start = firstVisibleText();
      }
      if (!start) return flash('No text in view', true);
      sel.setBaseAndExtent(start.node, start.offset, start.node, start.offset);
      sel.modify('extend', 'forward', 'character');
    }
    setMode('visual');
    if (linewise) toLinewise();
  }

  function lineEnds(p) {
    const sel = getSelection();
    sel.setBaseAndExtent(p.node, p.offset, p.node, p.offset);
    sel.modify('move', 'backward', 'lineboundary');
    const start = point(sel.anchorNode, sel.anchorOffset);
    sel.modify('move', 'forward', 'lineboundary');
    return { start, end: point(sel.focusNode, sel.focusOffset) };
  }

  function toLinewise() {
    const sel = getSelection();
    lineFocus = point(sel.focusNode, sel.focusOffset);
    lineAnchor = lineEnds(point(sel.anchorNode, sel.anchorOffset));
    setMode('vline');
    snapLines();
  }

  function snapLines() {
    const sel = getSelection();
    if (comparePoints(lineFocus, lineAnchor.start) < 0) {
      sel.setBaseAndExtent(lineAnchor.end.node, lineAnchor.end.offset, lineFocus.node, lineFocus.offset);
      sel.modify('extend', 'backward', 'lineboundary');
    } else {
      sel.setBaseAndExtent(lineAnchor.start.node, lineAnchor.start.offset, lineFocus.node, lineFocus.offset);
      sel.modify('extend', 'forward', 'lineboundary');
    }
  }

  function exitVisual() {
    getSelection().removeAllRanges();
    lineAnchor = lineFocus = null;
    setMode('normal');
  }

  function revealFocus() {
    const sel = getSelection();
    if (!sel.focusNode) return;
    const range = document.createRange();
    range.setStart(sel.focusNode, sel.focusOffset);
    range.collapse(true);
    const r = rangeRect(range);
    if (!r) return;
    if (r.top < 40) window.scrollBy(0, r.top - 120);
    else if (r.bottom > viewH() - 40) window.scrollBy(0, r.bottom - viewH() + 120);
  }

  function extend(apply) {
    const sel = getSelection();
    if (mode === 'vline') {
      // Motions act on the raw focus, not the snapped line end.
      sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, lineFocus.node, lineFocus.offset);
    }
    apply(sel);
    if (mode === 'vline') {
      lineFocus = point(sel.focusNode, sel.focusOffset);
      snapLines();
    }
    revealFocus();
  }

  let visualPending = '';

  function onVisualKey(k) {
    if (/^[0-9]$/.test(k) && (count || k !== '0')) {
      count += k;
      showKeys();
      return true;
    }
    const n = count ? parseInt(count, 10) : 1;
    const pendingG = visualPending === 'g';
    visualPending = '';
    count = '';
    showKeys();

    if (pendingG) {
      if (k === 'g') extend((sel) => sel.extend(content, 0));
      return true;
    }
    const motion = VISUAL_MOTIONS[k];
    if (motion) {
      extend((sel) => { for (let i = 0; i < n; i++) sel.modify('extend', motion[0], motion[1]); });
      return true;
    }
    const sel = getSelection();
    switch (k) {
      case 'g': visualPending = 'g'; showKeys(); break;
      case 'G': extend((s) => s.extend(content, content.childNodes.length)); break;
      case 'C-d': case 'C-f': extend((s) => { for (let i = 0; i < 12 * n; i++) s.modify('extend', 'forward', 'line'); }); break;
      case 'C-u': case 'C-b': extend((s) => { for (let i = 0; i < 12 * n; i++) s.modify('extend', 'backward', 'line'); }); break;
      case 'o':
        if (mode === 'visual') sel.setBaseAndExtent(sel.focusNode, sel.focusOffset, sel.anchorNode, sel.anchorOffset);
        revealFocus();
        break;
      case 'y': case 'C-c': {
        const text = sel.toString();
        exitVisual();
        yank(text);
        break;
      }
      case 'v':
        if (mode === 'visual') exitVisual(); else { lineAnchor = lineFocus = null; setMode('visual'); }
        break;
      case 'V':
        if (mode === 'vline') exitVisual(); else toLinewise();
        break;
      case 'Escape': case 'q': exitVisual(); break;
      default: return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- normal mode

  const marks = {};
  let count = '';
  let pending = [];

  function showKeys() {
    keysEl.textContent = count + pending.join('') + visualPending;
  }

  function resetKeys() {
    count = '';
    pending = [];
    showKeys();
  }

  const half = () => Math.round(viewH() / 2);
  const page = () => viewH() - LINE;

  const NORMAL = {
    'j': (n) => window.scrollBy(0, LINE * n),
    'k': (n) => window.scrollBy(0, -LINE * n),
    'ArrowDown': (n) => window.scrollBy(0, LINE * n),
    'ArrowUp': (n) => window.scrollBy(0, -LINE * n),
    'C-e': (n) => window.scrollBy(0, LINE * n),
    'C-y': (n) => window.scrollBy(0, -LINE * n),
    'h': (n) => window.scrollBy(-LINE * n, 0),
    'l': (n) => window.scrollBy(LINE * n, 0),
    'd': (n) => window.scrollBy(0, half() * n),
    'u': (n) => window.scrollBy(0, -half() * n),
    'C-d': (n) => window.scrollBy(0, half() * n),
    'C-u': (n) => window.scrollBy(0, -half() * n),
    'C-f': (n) => window.scrollBy(0, page() * n),
    'C-b': (n) => window.scrollBy(0, -page() * n),
    'Space': (n) => window.scrollBy(0, page() * n),
    'S-Space': (n) => window.scrollBy(0, -page() * n),
    'PageDown': (n) => window.scrollBy(0, page() * n),
    'PageUp': (n) => window.scrollBy(0, -page() * n),
    'g g': (n, has) => (has ? gotoLine(n) : jump(0)),
    'Home': () => jump(0),
    'G': (n, has) => (has ? gotoLine(n) : jump(maxY())),
    'End': () => jump(maxY()),
    '%': (n, has) => has && jump((maxY() * Math.min(n, 100)) / 100),
    '] ]': (n) => stepTo(headings(), 1, n),
    '[ [': (n) => stepTo(headings(), -1, n),
    '}': (n) => stepTo(blocks(), 1, n),
    '{': (n) => stepTo(blocks(), -1, n),
    'g O': openToc,
    't': openToc,
    'C-o': jumpBack,
    'C-i': jumpForward,
    'Tab': jumpForward,
    'H': () => post('back', {}) || flash('No previous file'),
    'L': () => post('forward', {}) || flash('No next file'),
    '/': () => openPrompt('/'),
    '?': () => openPrompt('?'),
    ':': () => openPrompt(':'),
    'n': (n) => searchNext(n, false),
    'N': (n) => searchNext(n, true),
    'f': followHints,
    'y f': yankLinkHints,
    'y c': yankCodeHints,
    'y y': () => post('yank-source', {}) ? flash('Yanked markdown source') : yank(content.innerText, 'document text'),
    'y p': () => post('yank-path', {}) ? flash('Yanked file path') : yank(location.href, 'location'),
    'v': () => enterVisual(false),
    'V': () => enterVisual(true),
    'r': () => post('reload', {}) || location.reload(),
    '+': () => post('zoom', { dir: 1 }),
    '-': () => post('zoom', { dir: -1 }),
    '=': () => post('zoom', { dir: 0 }),
    'g t': () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true),
    'g ?': openHelp,
    'F1': openHelp,
    'q': () => post('quit', {}),
    'Z Z': () => post('quit', {}),
    'Z Q': () => post('quit', {}),
  };

  const PREFIXES = new Set(["m", "'", '`']);
  for (const seq of Object.keys(NORMAL)) {
    const keys = seq.split(' ');
    for (let i = 1; i < keys.length; i++) PREFIXES.add(keys.slice(0, i).join(' '));
  }

  function onNormalKey(k) {
    if (k === 'Escape') {
      resetKeys();
      clearSearch();
      getSelection().removeAllRanges();
      return true;
    }
    const sel = getSelection();
    const hasSelection = sel.rangeCount && !sel.isCollapsed && content.contains(sel.anchorNode);
    if (!pending.length && hasSelection && (k === 'y' || k === 'C-c')) {
      const text = sel.toString();
      sel.removeAllRanges();
      yank(text);
      return true;
    }
    if (!pending.length && /^[0-9]$/.test(k) && (count || k !== '0')) {
      count += k;
      showKeys();
      return true;
    }
    if (pending.length === 1 && k.length === 1 && "m'`".includes(pending[0])) {
      const set = pending[0] === 'm';
      resetKeys();
      if (set) {
        marks[k] = window.scrollY;
      } else if (k === "'" || k === '`') {
        const back = prevPos;
        jump(back);
      } else if (k in marks) {
        jump(marks[k]);
      } else {
        flash(`Mark not set: ${k}`, true);
      }
      return true;
    }
    const seq = [...pending, k].join(' ');
    const run = NORMAL[seq];
    if (run) {
      const n = count ? parseInt(count, 10) : 1;
      const has = !!count;
      resetKeys();
      run(n, has);
      return true;
    }
    if (PREFIXES.has(seq)) {
      pending.push(k);
      showKeys();
      return true;
    }
    const partial = pending.length > 0 || count !== '';
    resetKeys();
    return partial;
  }

  // ---------------------------------------------------------------- key dispatch

  const NAMED = new Set(['Escape', 'Enter', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
    'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'F1']);

  function keyName(e) {
    let k = e.key;
    if (k === ' ') k = 'Space';
    if (k.length > 1 && !NAMED.has(k) && k !== 'Space') return null;
    if (e.metaKey || e.altKey) return null;
    if (e.ctrlKey) {
      if (k === '[') return 'Escape';
      return `C-${k.length === 1 ? k.toLowerCase() : k}`;
    }
    if (k === 'Space' && e.shiftKey) return 'S-Space';
    return k;
  }

  function onPromptKey(k) {
    switch (k) {
      case 'Enter': commitPrompt(); return true;
      case 'Escape': case 'C-c': cancelPrompt(); return true;
      case 'C-u': inputEl.value = ''; inputEl.dispatchEvent(new Event('input')); return true;
      case 'C-w':
        inputEl.value = inputEl.value.replace(/\S*\s*$/, '');
        inputEl.dispatchEvent(new Event('input'));
        return true;
      case 'Backspace':
        if (!inputEl.value) { cancelPrompt(); return true; }
        return false;
      default: return false;
    }
  }

  let userMoved = false;

  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const k = keyName(e);
    if (!k) return;
    userMoved = true;
    let handled;
    switch (mode) {
      case 'cmd': handled = onPromptKey(k); break;
      case 'hint': handled = onHintKey(k); break;
      case 'panel': handled = onPanelKey(k); break;
      case 'visual': case 'vline': handled = onVisualKey(k); break;
      default: handled = onNormalKey(k);
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener('wheel', () => (userMoved = true), { passive: true });

  // ---------------------------------------------------------------- media & diagrams

  function mediaFailed(media) {
    const src = media.currentSrc || media.getAttribute('src') || media.querySelector('source')?.getAttribute('src');
    if (!src || media.nextElementSibling?.classList.contains('mdr-media-fallback')) return;
    const link = el('a', { class: 'mdr-media-fallback', href: src }, `Can't play ${media.tagName.toLowerCase()} here — open in external player`);
    media.after(link);
  }

  document.addEventListener('error', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !content.contains(t)) return;
    if (t.tagName === 'IMG') t.classList.add('mdr-broken');
    else if (t.tagName === 'VIDEO' || t.tagName === 'AUDIO') mediaFailed(t);
    else if (t.tagName === 'SOURCE' && !t.nextElementSibling && t.parentElement.matches('video,audio')) mediaFailed(t.parentElement);
  }, true);

  content.addEventListener('click', (e) => e.target.closest?.('.spoiler')?.classList.toggle('revealed'));

  function loadMermaid() {
    const diagrams = content.querySelectorAll('pre.mermaid');
    if (!diagrams.length || !INIT.mermaid) return;
    const script = document.createElement('script');
    script.src = INIT.mermaid;
    script.nonce = NONCE;
    script.onload = () => {
      try {
        const dark = document.documentElement.dataset.theme === 'dark';
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        window.mermaid.run({ nodes: diagrams }).catch(() => {});
      } catch { /* leave the source visible */ }
    };
    document.head.append(script);
  }

  // ---------------------------------------------------------------- startup

  window.mdr = { flash };
  history.scrollRestoration = 'manual';
  setTheme(theme, false);
  setMode('normal');

  function restore() {
    if (INIT.fragment) gotoFragment(INIT.fragment, false);
    else if (INIT.scroll) scrollToY(INIT.scroll);
    updatePos();
  }
  restore();
  // Images change the layout as they load; re-apply unless the reader moved on.
  window.addEventListener('load', () => !userMoved && restore());

  if (INIT.notice) flash(INIT.notice);
  loadMermaid();
})();
