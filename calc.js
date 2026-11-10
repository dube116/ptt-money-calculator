/*
 * PTT 發文稿酬（P幣）估算 — 現行版本（2026/11/01 約 05:00 之後）的推測規則
 * 以唯讀 BBS 取得的實際稿酬反推；非官方公式，站方可能隨時調整。
 *
 * 瀏覽器與 Node.js 共用（Node 端用於和 Python 版逐篇比對）。
 */
(function (root) {
  'use strict';

  const RULE = {
    cap: 2,            // 每個不同詞元最多計幾次
    tokenW: 2,         // 每個詞元的分數（漢字、英數串都是 2 分；11/01 前英數每字元 1 分）
    ratio: 0.05,       // 分數 → P幣，四捨五入（11/01 約 05:00 起；10/27~10/31 為 0.1 捨去）
    minThresh: 0,      // 10/27 起實測無有效門檻（分數 10 以上即有 1P；之前為 40）
    maxMoney: 150,     // 單篇上限
    dailyPenalty: 3,   // 當天之前每有一篇實拿 5P 以上，扣幾 P（11/01 起；之前是有稿酬就算）
    postCapMin: 1,     // 扣完最低保留
    titleCaps: { '新聞': 5, '情報': 30 },
    capBeforePenalty: [5],   // 先套上限再扣遞減的上限值（[新聞]）
    sigMaxLines: 10,         // 文末簽名檔（最後兩條 -- 之間）最多幾行，超過就視為沒有簽名檔
  };

  const isAscii = (ch) => ch.codePointAt(0) < 128;
  // 只算漢字（假名、注音、全形標點符號都不算）；範圍與 Python 版 is_han 相同
  const isHan = (ch) => {
    const o = ch.codePointAt(0);
    return (o >= 0x4E00 && o <= 0x9FFF) || (o >= 0x3400 && o <= 0x4DBF) || (o >= 0xF900 && o <= 0xFAFF) || (o >= 0x20000 && o <= 0x3134F);
  };
  const isQuoteOrSystem = (ln) => {
    const l = ln.replace(/^ +/, '');
    return l.startsWith(': ') || l === ':' || l.startsWith('※') || l.startsWith('>');   // > 開頭＝Markdown 式引用
  };

  /**
   * 把貼上的文章拆成逐行標記：每行標上「計分 / 不計分（原因）」。
   * 回傳 { lines: [{text, counted, reason}], content }，content 為實際計分的文字。
   */
  function analyzeLines(raw) {
    let lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const out = lines.map((text) => ({ text, counted: true, reason: '' }));
    const mark = (i, reason) => { if (out[i].counted) { out[i].counted = false; out[i].reason = reason; } };

    // 標頭：開頭的「作者/標題/時間」直到第一個空行
    let i0 = 0;
    if (lines.length && /^\s*(作者|發信人)[:：]/.test(lines[0])) {
      while (i0 < lines.length && lines[i0].trim()) { mark(i0, '標頭'); i0++; }
    }
    // 發信站行之後（文章網址、推文）全部不算
    let end = lines.length;
    for (let i = i0; i < lines.length; i++) {
      if (lines[i].startsWith('※ 發信站')) { end = i; break; }
    }
    for (let i = end; i < lines.length; i++) mark(i, '發信站與之後');
    // 簽名檔（單獨一行 -- 為分隔線）：文末是「-- / sigMaxLines 行以內 / --」→ 第一條 -- 之後都不算；
    // 文末最後一段比這長（沒有簽名檔）→ 只有最後一條 -- 之後不算；兩條 -- 只夾一行的裝飾（文末那組除外）不當分隔線
    const dash = [];
    for (let i = i0; i < end; i++) if (lines[i].trim() === '--') dash.push(i);
    const drop = new Set();
    for (let j = 0; j < dash.length - 3; j++) {
      if (!drop.has(dash[j]) && dash[j + 1] - dash[j] - 1 <= 1) { drop.add(dash[j]); drop.add(dash[j + 1]); }
    }
    const d = dash.filter((i) => !drop.has(i));
    let sigAt = end;
    if (d.length) {
      const hasSig = d.length >= 2 && d[d.length - 1] - d[d.length - 2] - 1 <= RULE.sigMaxLines;
      sigAt = hasSig ? d[0] : d[d.length - 1];
    }
    for (let i = sigAt; i < end; i++) mark(i, '簽名檔');
    // 引用行與 ※ 開頭的系統行
    for (let i = i0; i < sigAt; i++) {
      if (isQuoteOrSystem(lines[i])) mark(i, lines[i].replace(/^ +/, '').startsWith('※') ? '※ 系統行' : '引用');
    }
    const content = out.filter((l) => l.counted).map((l) => l.text).join('\n');
    return { lines: out, content };
  }

  const URL_RE = /https?:\/\/[!-~]+/g;   // 遇到空白或非 ASCII 字元就結束（網址後緊接的中文仍計分）

  function tokenize(content) {
    const noUrl = content.replace(URL_RE, '');
    const toks = [];
    for (const ch of noUrl) if (isHan(ch)) toks.push(ch);
    // 英數串（含純數字）；不分大小寫（Blk52 與 blk52 算同一個）
    for (const w of noUrl.match(/[A-Za-z0-9_]+/g) || []) toks.push(w.toLowerCase());
    return toks;
  }

  const weightOf = () => RULE.tokenW;

  function scoreTokens(toks) {
    const cnt = new Map();
    for (const t of toks) cnt.set(t, (cnt.get(t) || 0) + 1);
    let score = 0, cjk = 0, ascii = 0;
    const dropped = [];
    for (const [k, n] of cnt) {
      const w = weightOf(k), used = Math.min(n, RULE.cap), s = w * used;
      score += s;
      if (isAscii(k[0])) ascii += s; else cjk += s;
      if (n > RULE.cap) dropped.push({ token: k, count: n, lost: w * (n - RULE.cap) });
    }
    dropped.sort((a, b) => b.lost - a.lost || b.count - a.count);
    return { score, cjk, ascii, total: toks.length, distinct: cnt.size, dropped };
  }

  function titleCap(title) {
    if (!title) return null;
    // 標題任何位置有 [新聞] 都算，回文 Re: [新聞] 也一樣（11/10 實測）
    if (title.includes('[新聞]')) return RULE.titleCaps['新聞'];
    if (/^\s*(R:|Re:|RE:)/.test(title)) return null;
    const m = title.match(/^\s*(?:Fw:\s*)?\[(.+?)\]/);
    return m && Object.prototype.hasOwnProperty.call(RULE.titleCaps, m[1].trim()) ? RULE.titleCaps[m[1].trim()] : null;
  }

  /**
   * @param {string} text     文章內容（可含標頭、簽名檔、發信站、推文，會自動剔除）
   * @param {string} title    標題（判斷 Fw:、[新聞]、[情報]）
   * @param {number} postsToday 當天（0:00 起）在這篇之前發出、且實拿 5P 以上的篇數
   */
  function calc(text, title = '', postsToday = 0) {
    const lines = analyzeLines(text || '');
    const urls = (lines.content.match(URL_RE) || []).length;
    const st = scoreTokens(tokenize(lines.content));
    const r = { ...st, urls, lines: lines.lines, title: title || '', postsToday };
    if (title && /^\s*Fw:/.test(title)) {
      return { ...r, base: 0, capped: 0, afterPenalty: 0, cap: null, money: 0, note: '轉錄（Fw:）文章沒有稿酬' };
    }
    const base = st.score < RULE.minThresh ? 0 : Math.min(RULE.maxMoney, Math.floor(st.score * RULE.ratio + 0.5));
    const cap = titleCap(title);
    // [新聞] 的 5P 上限先套再扣當日遞減；[情報] 的 30P 上限在遞減之後套（11/05 起實測）
    const before = cap !== null && RULE.capBeforePenalty.includes(cap);
    const capped = before ? Math.min(base, cap) : base;
    const afterPenalty = capped > 0 ? Math.max(RULE.postCapMin, capped - RULE.dailyPenalty * Math.max(0, postsToday | 0)) : 0;
    const money = cap !== null && !before ? Math.min(afterPenalty, cap) : afterPenalty;
    let note = '';
    if (base === 0 && st.total > 0) note = '分數未滿 10，沒有稿酬';
    return { ...r, base, capped, afterPenalty, cap, money, note };
  }

  /**
   * 把計分範圍內的每一行切成片段，供畫面標示：
   *   ok  = 計分        dup = 同一詞元第 3 次以後（不計分）
   *   url = 網址         ns  = 漢字以外的全形字元（假名、注音、標點…）、半形符號（不計分）
   * 詞元出現次數依文章順序跨行累計，與 scoreTokens 的去重結果一致。
   */
  function annotate(lines) {
    const seen = new Map();
    const hit = (tok) => { const n = (seen.get(tok) || 0) + 1; seen.set(tok, n); return n > RULE.cap ? 'dup' : 'ok'; };
    return lines.map((l) => {
      if (!l.counted) return [{ text: l.text, kind: 'off' }];
      const segs = [];
      const push = (text, kind) => {
        const last = segs[segs.length - 1];
        if (last && last.kind === kind) last.text += text; else segs.push({ text, kind });
      };
      const re = /(https?:\/\/[!-~]+)|([A-Za-z0-9_]+)/g;
      let pos = 0, m;
      const plain = (s) => {
        for (const ch of s) {
          if (isHan(ch)) push(ch, hit(ch));
          else push(ch, /\s/.test(ch) ? 'ok' : 'ns');
        }
      };
      while ((m = re.exec(l.text))) {
        plain(l.text.slice(pos, m.index));
        if (m[1]) push(m[1], 'url');
        else push(m[2], hit(m[2].toLowerCase()));
        pos = re.lastIndex;
      }
      plain(l.text.slice(pos));
      return segs;
    });
  }

  const api = { RULE, isHan, analyzeLines, tokenize, scoreTokens, calc, annotate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PttMoney = api;
})(typeof window !== 'undefined' ? window : globalThis);
