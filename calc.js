/*
 * PTT 發文稿酬（P幣）估算 — 現行版本（2026/10/27 11:59 之後）的推測規則
 * 以唯讀 BBS 取得的實際稿酬反推；非官方公式，站方可能隨時調整。
 *
 * 瀏覽器與 Node.js 共用（Node 端用於和 Python 版逐篇比對）。
 */
(function (root) {
  'use strict';

  const RULE = {
    cap: 2,            // 每個不同詞元最多計幾次
    asciiMax: 8,       // 每個英數詞最多算 8 分（去重看完整的詞）
    ratio: 0.1,        // 分數 → P幣（10/27 11:59 起；之前為 0.08）
    minThresh: 0,      // 10/27 起實測無有效門檻（分數 10 以上即有 1P；之前為 40）
    maxMoney: 150,     // 單篇上限
    dailyPenalty: 3,   // 當天之前每有一篇拿到稿酬，扣幾 P
    postCapMin: 1,     // 扣完最低保留
    titleCaps: { '新聞': 5, '情報': 30 },
  };

  const isAscii = (ch) => ch.codePointAt(0) < 128;
  const isQuoteOrSystem = (ln) => {
    const l = ln.replace(/^ +/, '');
    return l.startsWith(': ') || l === ':' || l.startsWith('※');
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
    // 內文中第一個單獨的 -- 行之後都視為簽名檔
    let sigAt = end;
    for (let i = i0; i < end; i++) {
      if (lines[i].trim() === '--') { sigAt = i; break; }
    }
    for (let i = sigAt; i < end; i++) mark(i, '簽名檔');
    // 引用行與 ※ 開頭的系統行
    for (let i = i0; i < sigAt; i++) {
      if (isQuoteOrSystem(lines[i])) mark(i, lines[i].replace(/^ +/, '').startsWith('※') ? '※ 系統行' : '引用');
    }
    const content = out.filter((l) => l.counted).map((l) => l.text).join('\n');
    return { lines: out, content };
  }

  const URL_RE = /https?:\/\/\S+/g;

  function tokenize(content) {
    const noUrl = content.replace(URL_RE, '');
    const toks = [];
    for (const ch of noUrl) if (!isAscii(ch) && !(ch >= '０' && ch <= '９')) toks.push(ch);   // 全形數字不算
    const words = noUrl.match(/[A-Za-z0-9_]+/g) || [];
    for (const w of words) if (!/^[0-9_]+$/.test(w)) toks.push(w);
    return toks;
  }

  const weightOf = (tok) => (isAscii(tok[0]) ? Math.min(tok.length, RULE.asciiMax) : 2);

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
    if (!title || /^\s*(R:|Re:|RE:)/.test(title)) return null;
    const m = title.match(/^\s*(?:Fw:\s*)?\[(.+?)\]/);
    return m && Object.prototype.hasOwnProperty.call(RULE.titleCaps, m[1].trim()) ? RULE.titleCaps[m[1].trim()] : null;
  }

  /**
   * @param {string} text     文章內容（可含標頭、簽名檔、發信站、推文，會自動剔除）
   * @param {string} title    標題（判斷 Fw:、[新聞]、[情報]）
   * @param {number} postsToday 當天（0:00 起）在這篇之前發出、且有拿到稿酬的篇數
   */
  function calc(text, title = '', postsToday = 0) {
    const lines = analyzeLines(text || '');
    const urls = (lines.content.match(URL_RE) || []).length;
    const st = scoreTokens(tokenize(lines.content));
    const r = { ...st, urls, lines: lines.lines, title: title || '', postsToday };
    if (title && /^\s*Fw:/.test(title)) {
      return { ...r, base: 0, afterPenalty: 0, cap: null, money: 0, note: '轉錄（Fw:）文章沒有稿酬' };
    }
    const base = st.score < RULE.minThresh ? 0 : Math.min(RULE.maxMoney, Math.floor(st.score * RULE.ratio + 1e-9));
    const afterPenalty = base > 0 ? Math.max(RULE.postCapMin, base - RULE.dailyPenalty * Math.max(0, postsToday | 0)) : 0;
    const cap = titleCap(title);
    const money = cap === null ? afterPenalty : Math.min(afterPenalty, cap);
    let note = '';
    if (base === 0 && st.total > 0) note = '分數未滿 10，沒有稿酬';
    return { ...r, base, afterPenalty, cap, money, note };
  }

  /**
   * 把計分範圍內的每一行切成片段，供畫面標示：
   *   ok  = 計分        dup = 同一詞元第 3 次以後（不計分）
   *   url = 網址         ns  = 純數字、半形符號（不計分）
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
      const re = /(https?:\/\/\S+)|([A-Za-z0-9_]+)/g;
      let pos = 0, m;
      const plain = (s) => {
        for (const ch of s) {
          if (ch >= '０' && ch <= '９') push(ch, 'ns');   // 全形數字不算
          else if (!isAscii(ch)) push(ch, hit(ch));
          else push(ch, /\s/.test(ch) ? 'ok' : 'ns');
        }
      };
      while ((m = re.exec(l.text))) {
        plain(l.text.slice(pos, m.index));
        if (m[1]) push(m[1], 'url');
        else if (/^[0-9_]+$/.test(m[2])) push(m[2], 'ns');
        else push(m[2], hit(m[2]));
        pos = re.lastIndex;
      }
      plain(l.text.slice(pos));
      return segs;
    });
  }

  const api = { RULE, analyzeLines, tokenize, scoreTokens, calc, annotate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PttMoney = api;
})(typeof window !== 'undefined' ? window : globalThis);
