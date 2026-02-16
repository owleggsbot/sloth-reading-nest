/* Sloth Reading Nest — offline-first reading tracker.
   No deps, no backend. Data is localStorage + optional export/import.
*/

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STORAGE_KEY = 'sloth-reading-nest:v1';

const state = {
  books: [],
  sessions: [],
  nowId: null,
  prompt: null,
  timer: {
    totalSec: 20 * 60,
    leftSec: 20 * 60,
    running: false,
    startedAt: null,
    raf: null,
  },
  card: {
    includeStats: true,
    includePrompt: true,
  },
  shelfFilter: {
    q: '',
    status: 'all'
  }
};

function uid(){
  return Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function fmtDate(ts){
  const d = new Date(ts);
  return d.toLocaleString(undefined, {year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}

function fmtHM(sec){
  const m = Math.floor(sec/60);
  const s = Math.floor(sec%60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function safeInt(v){
  const n = parseInt(String(v||'').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function load(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const data = JSON.parse(raw);
    if(!data || typeof data !== 'object') return;
    state.books = Array.isArray(data.books) ? data.books : [];
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    state.nowId = data.nowId || null;
    state.prompt = data.prompt || null;
    if(data.timerMinutes){
      const sec = clamp(data.timerMinutes, 5, 180) * 60;
      state.timer.totalSec = sec;
      state.timer.leftSec = sec;
    }
  }catch(e){
    console.warn('load failed', e);
  }
}

function save(){
  const timerMinutes = Math.round(state.timer.totalSec/60);
  const data = {
    books: state.books,
    sessions: state.sessions,
    nowId: state.nowId,
    prompt: state.prompt,
    timerMinutes,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function todayKey(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function seededRand(seedStr){
  // xmur3 + sfc32
  function xmur3(str){
    let h = 1779033703 ^ str.length;
    for(let i=0;i<str.length;i++){
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function(){
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }
  function sfc32(a,b,c,d){
    return function(){
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }
  const seed = xmur3(seedStr);
  return sfc32(seed(), seed(), seed(), seed());
}

const PROMPTS = [
  'Read one paragraph like it’s a leaf you’re tasting for the first time.',
  'Pick a sentence you love and copy it somewhere. Tiny shrine.',
  'What would the main character smell right now? Be weirdly specific.',
  'Pause after a page and let the scene settle like fog.',
  'Read slower than you think you should. You’re allowed.',
  'Find one detail you’d miss if you were rushing.',
  'If this book were tea, what kind would it be?',
  'Stop mid-page when you feel “oh!” and savor it for ten seconds.',
  'Before you start: loosen your jaw. Yes, really.',
  'When you finish: close the book like you’re tucking it into a nest.',
];

function newPrompt(fresh=false){
  // daily seeded, unless fresh
  const r = fresh ? Math.random() : seededRand('sloth-reading-nest:' + todayKey());
  const idx = Math.floor(r() * PROMPTS.length);
  state.prompt = PROMPTS[idx];
  save();
}

function getBook(id){ return state.books.find(b => b.id === id) || null; }

function setNow(id){
  state.nowId = id;
  save();
  render();
}

function upsertBook(book){
  const i = state.books.findIndex(b => b.id === book.id);
  if(i >= 0) state.books[i] = book;
  else state.books.unshift(book);
  if(!state.nowId && book.status === 'reading') state.nowId = book.id;
  save();
  render();
}

function deleteBook(id){
  state.books = state.books.filter(b => b.id !== id);
  state.sessions = state.sessions.filter(s => s.bookId !== id);
  if(state.nowId === id) state.nowId = null;
  save();
  render();
}

function exportData(){
  const payload = {
    app: 'sloth-reading-nest',
    version: 1,
    exportedAt: Date.now(),
    data: {
      books: state.books,
      sessions: state.sessions,
      nowId: state.nowId,
      prompt: state.prompt,
      timerMinutes: Math.round(state.timer.totalSec/60)
    }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sloth-reading-nest-export-${todayKey()}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 500);
}

function csvEscape(v){
  if(v === null || v === undefined) return '';
  const s = String(v);
  if(/[\",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportSessionsCSV(){
  // Chronological (oldest first) so it pastes nicely into spreadsheets.
  const byId = new Map(state.books.map(b => [b.id, b]));
  const rows = [];
  rows.push([
    'at_iso',
    'at_local',
    'book_id',
    'book_title',
    'book_author',
    'minutes',
    'pages_read',
    'mood_after'
  ]);

  const list = [...state.sessions].reverse();
  for(const s of list){
    const b = byId.get(s.bookId) || {};
    const at = new Date(s.at);
    rows.push([
      at.toISOString(),
      at.toLocaleString(),
      s.bookId || '',
      b.title || '',
      b.author || '',
      s.minutes ?? '',
      s.pagesRead ?? '',
      s.moodAfter || ''
    ]);
  }

  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sloth-reading-nest-sessions-${todayKey()}.csv`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 500);
  toast('Sessions CSV exported.');
}

function importDataFromFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const payload = JSON.parse(String(reader.result||''));
      const d = payload?.data;
      if(payload?.app !== 'sloth-reading-nest' || !d) throw new Error('Not a Sloth Reading Nest export');
      state.books = Array.isArray(d.books) ? d.books : [];
      state.sessions = Array.isArray(d.sessions) ? d.sessions : [];
      state.nowId = d.nowId || null;
      state.prompt = d.prompt || null;
      const m = safeInt(d.timerMinutes);
      if(m){
        state.timer.totalSec = clamp(m, 5, 180) * 60;
        state.timer.leftSec = state.timer.totalSec;
        $('#sessionMinutes').value = String(clamp(m, 5, 180));
      }
      save();
      render();
      toast('Imported. Welcome back to the nest.');
    }catch(e){
      alert('Import failed: ' + e.message);
    }
  };
  reader.readAsText(file);
}

function toast(msg){
  // minimalist toast
  let el = $('#_toast');
  if(!el){
    el = document.createElement('div');
    el.id = '_toast';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.bottom = '18px';
    el.style.transform = 'translateX(-50%)';
    el.style.padding = '10px 12px';
    el.style.borderRadius = '14px';
    el.style.border = '1px solid rgba(233,242,236,.18)';
    el.style.background = 'rgba(5,10,8,.72)';
    el.style.backdropFilter = 'blur(10px)';
    el.style.color = 'white';
    el.style.fontWeight = '700';
    el.style.fontSize = '13px';
    el.style.zIndex = 9999;
    el.style.maxWidth = 'min(560px, calc(100vw - 24px))';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.style.opacity='0'; }, 2500);
}

// ---- Timer ----
function setTimerMinutes(min){
  const sec = clamp(min, 5, 180) * 60;
  state.timer.totalSec = sec;
  state.timer.leftSec = sec;
  state.timer.running = false;
  state.timer.startedAt = null;
  save();
  renderTimer();
}

function tick(){
  if(!state.timer.running) return;
  const now = performance.now();
  const elapsed = (now - state.timer.startedAt) / 1000;
  const left = Math.max(0, Math.round(state.timer.totalSec - elapsed));
  state.timer.leftSec = left;
  renderTimer();
  if(left <= 0){
    state.timer.running = false;
    state.timer.startedAt = null;
    $('#btnStart').disabled = false;
    $('#btnPause').disabled = true;
    $('#timerHint').textContent = 'Done. Log it (or just bask).';
    ding();
    return;
  }
  state.timer.raf = requestAnimationFrame(tick);
}

function startTimer(){
  if(state.timer.running) return;
  state.timer.running = true;
  state.timer.startedAt = performance.now() - ((state.timer.totalSec - state.timer.leftSec) * 1000);
  $('#btnStart').disabled = true;
  $('#btnPause').disabled = false;
  $('#timerHint').textContent = 'Tiny steps. No sprinting.';
  state.timer.raf = requestAnimationFrame(tick);
}

function pauseTimer(){
  if(!state.timer.running) return;
  state.timer.running = false;
  cancelAnimationFrame(state.timer.raf);
  state.timer.raf = null;
  $('#btnStart').disabled = false;
  $('#btnPause').disabled = true;
  $('#timerHint').textContent = 'Paused. Sloths approve.';
}

function resetTimer(){
  state.timer.running = false;
  cancelAnimationFrame(state.timer.raf);
  state.timer.raf = null;
  state.timer.leftSec = state.timer.totalSec;
  state.timer.startedAt = null;
  $('#btnStart').disabled = false;
  $('#btnPause').disabled = true;
  $('#timerHint').textContent = 'Pick a book, then start slow.';
  save();
  renderTimer();
}

function ding(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 660;
    g.gain.value = 0.0001;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    o.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
    o.stop(ctx.currentTime + 0.6);
  }catch(e){
    // ignore
  }
}

function logSession(pagesRead, moodAfter){
  const nowBook = state.nowId ? getBook(state.nowId) : null;
  if(!nowBook){
    alert('Pick a “Now reading” book first.');
    return;
  }
  const minutes = Math.round(state.timer.totalSec/60);
  const entry = {
    id: uid(),
    at: Date.now(),
    bookId: nowBook.id,
    minutes,
    pagesRead: pagesRead ?? null,
    moodAfter,
  };
  state.sessions.unshift(entry);
  save();
  render();
  toast('Session logged. Slow wins.');
}

function clearSessions(){
  if(!confirm('Clear ALL session logs? This cannot be undone.')) return;
  state.sessions = [];
  save();
  render();
}

// ---- Share link ----
function makeSnapshot(){
  const b = state.nowId ? getBook(state.nowId) : null;
  const totalMin7 = state.sessions.filter(s => (Date.now() - s.at) < 7*864e5).reduce((a,s)=>a+s.minutes,0);
  const snap = {
    t: b?.title || null,
    a: b?.author || null,
    s: b?.status || null,
    p: b?.pages || null,
    m7: totalMin7,
    pr: state.prompt,
  };
  return snap;
}

async function shareSnapshotLink(){
  const snap = makeSnapshot();
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(snap))));
  const url = new URL(location.href);
  url.hash = 'snap=' + encoded;

  // Prefer native share sheet on mobile.
  try{
    if(navigator.share){
      await navigator.share({
        title: 'Sloth Reading Nest',
        text: 'A tiny, read-only snapshot from my reading nest.',
        url: url.toString(),
      });
      toast('Shared.');
      return;
    }
  }catch(e){
    // user cancelled / share failed → fall back to clipboard
  }

  try{
    await navigator.clipboard.writeText(url.toString());
    toast('Share link copied.');
  }catch(e){
    alert('Could not copy.');
  }
}

function tryLoadSnapshotFromHash(){
  const h = location.hash || '';
  const m = h.match(/snap=([^&]+)/);
  if(!m) return;
  try{
    const json = decodeURIComponent(escape(atob(m[1])));
    const snap = JSON.parse(json);
    // just store in memory for card rendering; do not overwrite library
    state._snapshot = snap;
    $('#timerHint').textContent = 'Viewing a shared snapshot (read-only).';
  }catch(e){
    // ignore
  }
}

// ---- Card rendering ----
function roundRect(ctx, x,y,w,h,r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr,y);
  ctx.arcTo(x+w,y, x+w,y+h, rr);
  ctx.arcTo(x+w,y+h, x,y+h, rr);
  ctx.arcTo(x,y+h, x,y, rr);
  ctx.arcTo(x,y, x+w,y, rr);
  ctx.closePath();
}

function drawSloth(ctx, x, y, s){
  // simple cozy sloth blob
  ctx.save();
  ctx.translate(x,y);
  ctx.scale(s,s);

  // branch
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  roundRect(ctx, -140, 90, 420, 26, 13);
  ctx.fill();

  // body
  ctx.fillStyle = 'rgba(122,224,168,.22)';
  ctx.beginPath();
  ctx.ellipse(70, 55, 120, 86, 0.05, 0, Math.PI*2);
  ctx.fill();

  // face
  ctx.fillStyle = 'rgba(255,255,255,.12)';
  ctx.beginPath();
  ctx.ellipse(85, 40, 62, 54, 0.1, 0, Math.PI*2);
  ctx.fill();

  // eyes
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.beginPath(); ctx.ellipse(65, 38, 7, 9, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(105, 38, 7, 9, 0, 0, Math.PI*2); ctx.fill();

  // smile
  ctx.strokeStyle = 'rgba(0,0,0,.45)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(85, 55, 16, 0.15*Math.PI, 0.85*Math.PI);
  ctx.stroke();

  // book
  ctx.fillStyle = 'rgba(134,184,255,.22)';
  roundRect(ctx, -25, 70, 90, 60, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(233,242,236,.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(20, 76); ctx.lineTo(20, 124);
  ctx.stroke();

  ctx.restore();
}

function drawCard(){
  const canvas = $('#cardCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // background gradient
  const g = ctx.createLinearGradient(0,0,W,H);
  g.addColorStop(0, '#0b1210');
  g.addColorStop(1, '#0f1a16');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,W,H);

  // glow
  const rg = ctx.createRadialGradient(220,140,10, 220,140,520);
  rg.addColorStop(0, 'rgba(122,224,168,.25)');
  rg.addColorStop(1, 'rgba(122,224,168,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0,0,W,H);

  const rg2 = ctx.createRadialGradient(980,120,10, 980,120,520);
  rg2.addColorStop(0, 'rgba(134,184,255,.20)');
  rg2.addColorStop(1, 'rgba(134,184,255,0)');
  ctx.fillStyle = rg2;
  ctx.fillRect(0,0,W,H);

  // panel
  ctx.fillStyle = 'rgba(255,255,255,.04)';
  ctx.strokeStyle = 'rgba(233,242,236,.12)';
  ctx.lineWidth = 2;
  roundRect(ctx, 44, 44, W-88, H-88, 28);
  ctx.fill();
  ctx.stroke();

  drawSloth(ctx, 110, 170, 1.0);

  const snap = state._snapshot || makeSnapshot();
  const title = snap.t || (state.nowId ? getBook(state.nowId)?.title : null) || 'A slow little reading session';
  const author = snap.a || (state.nowId ? getBook(state.nowId)?.author : null) || '';

  ctx.fillStyle = 'rgba(233,242,236,.92)';
  ctx.font = '800 44px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  wrapText(ctx, title, 360, 150, 770, 50, 2);

  ctx.fillStyle = 'rgba(233,242,236,.70)';
  ctx.font = '600 22px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  const meta = [author ? `by ${author}` : null, snap.p ? `${snap.p} pages` : null].filter(Boolean).join(' · ');
  if(meta) ctx.fillText(meta, 360, 240);

  // chips
  const stats = computeStats();
  let chips = [];
  if(state.card.includeStats){
    chips.push(`7d minutes: ${stats.min7}`);
    chips.push(`today: ${stats.minToday} min`);
    chips.push(`sessions: ${stats.sessionCount}`);
  }
  if(snap.s){
    chips.push(`status: ${snap.s}`);
  }

  drawChips(ctx, chips, 360, 280, 770);

  if(state.card.includePrompt){
    const pr = snap.pr || state.prompt;
    if(pr){
      ctx.fillStyle = 'rgba(122,224,168,.16)';
      ctx.strokeStyle = 'rgba(122,224,168,.26)';
      roundRect(ctx, 360, 360, 770, 140, 22);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(233,242,236,.90)';
      ctx.font = '700 18px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
      ctx.fillText('cozy prompt', 386, 396);
      ctx.fillStyle = 'rgba(233,242,236,.82)';
      ctx.font = '600 22px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
      wrapText(ctx, pr, 386, 430, 720, 30, 3);
    }
  }

  ctx.fillStyle = 'rgba(233,242,236,.55)';
  ctx.font = '700 16px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillText('Sloth Reading Nest', 78, H-72);

  ctx.fillStyle = 'rgba(233,242,236,.35)';
  ctx.font = '600 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  ctx.fillText(location.origin + location.pathname, 78, H-50);
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines){
  const words = String(text||'').split(/\s+/);
  let line = '';
  let lines = 0;
  for(const w of words){
    const test = line ? (line + ' ' + w) : w;
    if(ctx.measureText(test).width > maxW && line){
      ctx.fillText(line, x, y + lines*lineH);
      lines++;
      line = w;
      if(lines >= maxLines-1) break;
    }else{
      line = test;
    }
  }
  if(line && lines < maxLines){
    let out = line;
    if(lines === maxLines-1 && words.length > 0){
      // if overflow likely, add ellipsis
      while(ctx.measureText(out + '…').width > maxW && out.length > 3){
        out = out.slice(0, -2);
      }
      if(out !== line) out += '…';
    }
    ctx.fillText(out, x, y + lines*lineH);
  }
}

function drawChips(ctx, chips, x, y, maxW){
  if(!chips.length) return;
  ctx.font = '700 16px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
  let cx = x, cy = y;
  const padX=14, padY=10, gap=10, r=18;
  for(const c of chips){
    const w = ctx.measureText(c).width + padX*2;
    const h = 34;
    if(cx + w > x + maxW){
      cx = x;
      cy += h + gap;
    }
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.strokeStyle = 'rgba(233,242,236,.12)';
    roundRect(ctx, cx, cy, w, h, r);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(233,242,236,.80)';
    ctx.fillText(c, cx + padX, cy + 23);
    cx += w + gap;
  }
}

function canvasToBlob(canvas, type='image/png', quality){
  return new Promise((resolve, reject)=>{
    try{
      canvas.toBlob((blob)=>{
        if(!blob) return reject(new Error('toBlob returned null'));
        resolve(blob);
      }, type, quality);
    }catch(e){
      reject(e);
    }
  });
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = filename;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}

async function exportCard(){
  drawCard();
  const canvas = $('#cardCanvas');
  const filename = `sloth-reading-card-${todayKey()}.png`;
  try{
    const blob = await canvasToBlob(canvas, 'image/png');
    downloadBlob(blob, filename);
    toast('Reading card exported.');
  }catch(e){
    // Fallback: older browsers
    const a = document.createElement('a');
    a.download = filename;
    a.href = canvas.toDataURL('image/png');
    a.click();
  }
}

async function shareCard(){
  drawCard();
  const canvas = $('#cardCanvas');
  const filename = `sloth-reading-card-${todayKey()}.png`;

  // If the Web Share API can't share files here, just export.
  if(!navigator.share || !navigator.canShare){
    await exportCard();
    return;
  }

  try{
    const blob = await canvasToBlob(canvas, 'image/png');
    const file = new File([blob], filename, { type: 'image/png' });
    if(!navigator.canShare({ files: [file] })){
      await exportCard();
      return;
    }
    await navigator.share({
      title: 'Sloth Reading Nest — reading card',
      text: 'A cozy little reading card from my nest.',
      files: [file],
    });
    toast('Shared.');
  }catch(e){
    // user cancelled / share failed → export instead
    await exportCard();
  }
}

function computeStats(){
  const now = Date.now();
  const min7 = state.sessions.filter(s => (now - s.at) < 7*864e5).reduce((a,s)=>a+s.minutes,0);
  const minToday = state.sessions.filter(s => new Date(s.at).toDateString() === new Date().toDateString()).reduce((a,s)=>a+s.minutes,0);
  return { min7, minToday, sessionCount: state.sessions.length };
}

// ---- Rendering ----
function renderNow(){
  const box = $('#nowReading');
  const b = state.nowId ? getBook(state.nowId) : null;
  const snap = state._snapshot;
  if(snap){
    box.innerHTML = `
      <div class="now__title">${escapeHtml(snap.t || 'Shared snapshot')}</div>
      <div class="now__meta">${escapeHtml([snap.a ? `by ${snap.a}` : null, snap.p ? `${snap.p} pages` : null].filter(Boolean).join(' · '))}</div>
      <div class="now__chips">
        <span class="chip"><strong>read-only</strong> snapshot link</span>
        ${snap.s ? `<span class="chip">status: <strong>${escapeHtml(snap.s)}</strong></span>` : ''}
        ${Number.isFinite(snap.m7) ? `<span class="chip">7d minutes: <strong>${snap.m7}</strong></span>` : ''}
      </div>
    `;
    return;
  }

  if(!b){
    box.innerHTML = `
      <div class="now__title">No book selected</div>
      <div class="now__meta">Pick a book from your shelf (or add one). Then the timer + exports will use it.</div>
    `;
    return;
  }
  const recent = state.sessions.filter(s => s.bookId === b.id).slice(0,3);
  const last = recent[0];
  box.innerHTML = `
    <div class="now__title">${escapeHtml(b.title)}</div>
    <div class="now__meta">${escapeHtml(b.author ? `by ${b.author}` : '—')}</div>
    <div class="now__chips">
      <span class="chip">status: <strong>${escapeHtml(b.status)}</strong></span>
      ${b.pages ? `<span class="chip">pages: <strong>${escapeHtml(String(b.pages))}</strong></span>` : ''}
      ${last ? `<span class="chip">last session: <strong>${last.minutes} min</strong></span>` : `<span class="chip">no sessions yet</span>`}
    </div>
  `;
}

function renderShelf(){
  const el = $('#shelf');
  if(state._snapshot){
    el.innerHTML = '<p class="muted">Open without a #snap link to use your shelf.</p>';
    return;
  }

  const q = (state.shelfFilter.q || '').trim().toLowerCase();
  const status = state.shelfFilter.status || 'all';
  const filtered = state.books.filter(b => {
    if(status !== 'all' && b.status !== status) return false;
    if(!q) return true;
    const hay = [b.title, b.author, b.notes].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  if(!state.books.length){
    el.innerHTML = '<p class="muted">Your shelf is empty. Add a book. Name it something dramatic.</p>';
    return;
  }
  if(!filtered.length){
    el.innerHTML = `
      <p class="muted">No matches for <strong>${escapeHtml(q || '—')}</strong> (${escapeHtml(status)}).</p>
      <p class="muted">Tip: clear filters to see your full shelf.</p>
    `;
    return;
  }

  el.innerHTML = '';
  for(const b of filtered){
    const div = document.createElement('div');
    div.className = 'book';
    const meta = [b.author ? `by ${b.author}` : null, b.pages ? `${b.pages} pages` : null, `status: ${b.status}`].filter(Boolean).join(' · ');
    div.innerHTML = `
      <div>
        <div class="book__title">${escapeHtml(b.title)}</div>
        <div class="book__meta">${escapeHtml(meta)}</div>
        ${b.notes ? `<div class="book__notes">${escapeHtml(b.notes)}</div>` : ''}
      </div>
      <div class="book__actions">
        <button class="btn btn--ghost" data-act="now" data-id="${b.id}">Set now</button>
        <button class="btn btn--ghost" data-act="edit" data-id="${b.id}">Edit</button>
        <button class="btn btn--ghost" data-act="finish" data-id="${b.id}">Mark finished</button>
        <button class="btn btn--danger" data-act="del" data-id="${b.id}">Delete</button>
      </div>
    `;
    el.appendChild(div);
  }
}

function renderSessions(){
  const el = $('#sessions');
  if(state._snapshot){
    el.innerHTML = '';
    return;
  }
  if(!state.sessions.length){
    el.innerHTML = '<p class="muted">No sessions logged yet. Tiny timer, tiny win.</p>';
    return;
  }
  el.innerHTML = '';
  for(const s of state.sessions.slice(0, 12)){
    const b = getBook(s.bookId);
    const div = document.createElement('div');
    div.className = 'session';
    div.innerHTML = `
      <div>
        <div class="session__title">${escapeHtml(b?.title || 'Unknown book')}</div>
        <div class="session__meta">${escapeHtml(fmtDate(s.at))} · ${s.minutes} min · mood: ${escapeHtml(s.moodAfter || '—')}${s.pagesRead ? ` · pages: ${s.pagesRead}` : ''}</div>
      </div>
      <div class="muted">🦥</div>
    `;
    el.appendChild(div);
  }
}

function renderStats(){
  const el = $('#stats');
  if(state._snapshot){
    el.innerHTML = '';
    return;
  }
  const st = computeStats();
  el.innerHTML = `
    <div class="stat"><div class="stat__k">minutes today</div><div class="stat__v">${st.minToday}</div></div>
    <div class="stat"><div class="stat__k">minutes (last 7 days)</div><div class="stat__v">${st.min7}</div></div>
    <div class="stat"><div class="stat__k">sessions logged</div><div class="stat__v">${st.sessionCount}</div></div>
  `;
}

function renderTimer(){
  $('#timerTime').textContent = fmtHM(state.timer.leftSec);
}

function renderPrompt(){
  const el = $('#promptBox');
  if(!state.prompt) newPrompt(false);
  el.textContent = state.prompt || '';
}

function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, (c)=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function render(){
  renderNow();
  renderPrompt();
  renderTimer();
  renderStats();
  renderSessions();
  renderShelf();
  drawCard();
}

// ---- Events ----
function wire(){
  tryLoadSnapshotFromHash();

  // shelf filters
  const shelfSearch = $('#shelfSearch');
  const shelfStatus = $('#shelfStatus');
  const btnClearShelfFilters = $('#btnClearShelfFilters');
  if(shelfSearch && shelfStatus && btnClearShelfFilters){
    shelfSearch.value = state.shelfFilter.q || '';
    shelfStatus.value = state.shelfFilter.status || 'all';

    shelfSearch.addEventListener('input', (e)=>{
      state.shelfFilter.q = e.target.value;
      renderShelf();
    });
    shelfStatus.addEventListener('change', (e)=>{
      state.shelfFilter.status = e.target.value;
      renderShelf();
    });
    btnClearShelfFilters.addEventListener('click', ()=>{
      state.shelfFilter.q = '';
      state.shelfFilter.status = 'all';
      shelfSearch.value = '';
      shelfStatus.value = 'all';
      renderShelf();
    });
  }

  // timer length
  $('#sessionMinutes').addEventListener('change', (e)=>{
    const m = safeInt(e.target.value) || 20;
    setTimerMinutes(m);
  });

  $('#btnStart').addEventListener('click', startTimer);
  $('#btnPause').addEventListener('click', pauseTimer);
  $('#btnReset').addEventListener('click', resetTimer);

  $('#logForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    if(state._snapshot) return;
    const pagesRead = safeInt($('#pagesRead').value);
    const moodAfter = $('#moodAfter').value;
    logSession(pagesRead, moodAfter);
    $('#pagesRead').value = '';
    resetTimer();
  });

  $('#btnClearSessions').addEventListener('click', clearSessions);

  $('#btnRandomPrompt').addEventListener('click', ()=>{ newPrompt(true); render(); });

  $('#btnShare').addEventListener('click', ()=>{
    if(state._snapshot){
      toast('Snapshot already shared.');
      return;
    }
    shareSnapshotLink();
  });

  $('#btnExport').addEventListener('click', exportCard);
  $('#btnShareCard').addEventListener('click', shareCard);

  $('#toggleIncludeStats').addEventListener('change', (e)=>{ state.card.includeStats = e.target.checked; drawCard(); });
  $('#toggleIncludePrompt').addEventListener('change', (e)=>{ state.card.includePrompt = e.target.checked; drawCard(); });

  $('#btnNew').addEventListener('click', ()=>openBookForm());

  $('#bookForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const id = $('#bookId').value || uid();
    const title = $('#title').value.trim();
    const author = $('#author').value.trim();
    const pages = safeInt($('#pages').value);
    const status = $('#status').value;
    const notes = $('#notes').value.trim();
    upsertBook({id, title, author, pages, status, notes, updatedAt: Date.now()});
    closeBookForm();
  });
  $('#btnCancelEdit').addEventListener('click', closeBookForm);

  $('#shelf').addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-act]');
    if(!btn) return;
    const id = btn.getAttribute('data-id');
    const act = btn.getAttribute('data-act');
    const b = getBook(id);
    if(!b) return;
    if(act === 'now') setNow(id);
    if(act === 'edit') openBookForm(b);
    if(act === 'finish'){
      b.status = 'finished';
      upsertBook({...b, updatedAt: Date.now()});
    }
    if(act === 'del'){
      if(confirm(`Delete “${b.title}” and its sessions?`)) deleteBook(id);
    }
  });

  $('#btnExportData').addEventListener('click', exportData);
  $('#btnExportCSV').addEventListener('click', exportSessionsCSV);
  $('#btnImportData').addEventListener('click', ()=>$('#importFile').click());
  $('#importFile').addEventListener('change', (e)=>{
    const f = e.target.files?.[0];
    if(f) importDataFromFile(f);
    e.target.value = '';
  });

  $('#btnNuke').addEventListener('click', ()=>{
    if(!confirm('Delete ALL local data for Sloth Reading Nest? This cannot be undone.')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  // install prompt
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    deferredPrompt = e;
    const b = $('#btnInstall');
    b.hidden = false;
    b.onclick = async () => {
      b.hidden = true;
      deferredPrompt.prompt();
      try{ await deferredPrompt.userChoice; }catch{}
      deferredPrompt = null;
    };
  });

  // register SW
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }

  // initial
  render();
}

function openBookForm(book=null){
  if(state._snapshot) return;
  $('#bookId').value = book?.id || '';
  $('#title').value = book?.title || '';
  $('#author').value = book?.author || '';
  $('#pages').value = book?.pages ?? '';
  $('#status').value = book?.status || 'reading';
  $('#notes').value = book?.notes || '';
  // open details element
  const d = $('.details');
  d.open = true;
  $('#title').focus();
}

function closeBookForm(){
  $('#bookId').value = '';
  $('#bookForm').reset();
  $('.details').open = false;
}

// ---- Boot ----
load();
if(!state.prompt) newPrompt(false);
// If no reading book exists, set first reading as now
if(!state.nowId){
  const firstReading = state.books.find(b => b.status === 'reading');
  if(firstReading) state.nowId = firstReading.id;
}
// init timer from selector
$('#sessionMinutes').value = String(Math.round(state.timer.totalSec/60));

wire();
