import { File as MegaFile } from './vendor/megajs.mjs';

const $ = (s) => document.querySelector(s);
const HIDE_COLOR = 0.1; // proporción de color a partir de la cual es portada/solución
const LS = {
  get(k, d) { try { const v = localStorage.getItem('colorear.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('colorear.' + k, JSON.stringify(v)); } catch {} },
};

/* ---------- caché en IndexedDB ---------- */
const dbp = new Promise((res) => {
  try {
    const r = indexedDB.open('colorear', 2);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('blobs')) r.result.createObjectStore('blobs'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  } catch { res(null); }
});
async function idbGet(k) {
  const db = await dbp; if (!db) return null;
  return new Promise((res) => {
    try { const q = db.transaction('blobs').objectStore('blobs').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }
    catch { res(null); }
  });
}
async function idbPut(k, v) {
  const db = await dbp; if (!db) return;
  try { db.transaction('blobs', 'readwrite').objectStore('blobs').put(v, k); } catch {}
}

/* ---------- orígenes de datos ---------- */
class MegaSource {
  constructor(url) { this.url = url.trim(); this.id = 'mega:' + this.url.split('#')[0]; }
  async init() {
    let root;
    try {
      root = MegaFile.fromURL(this.url);
      await root.loadAttributes();
    } catch (err) {
      if (/decrypt/i.test(err.message)) throw new Error('la clave del enlace (lo que va tras «#») no corresponde a esa carpeta. Vuelve a copiar el enlace completo desde MEGA.');
      if (/Invalid argument|ENOENT|-9|-2/.test(err.message)) throw new Error('MEGA no encuentra esa carpeta. ¿Está bien copiado el enlace?');
      throw err;
    }
    const files = new Map();
    const walk = (node, prefix) => {
      for (const c of node.children || []) {
        const p = prefix + c.name;
        if (c.directory) walk(c, p + '/'); else files.set(p, c);
      }
    };
    if (root.directory) walk(root, ''); else throw new Error('El enlace no es de una carpeta');
    this.files = rebase(files);
  }
  async get(path) {
    const f = this.files.get(path);
    if (!f) throw new Error('No está en MEGA: ' + path);
    const buf = await f.downloadBuffer();
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
}
class LocalSource {
  constructor(fileList) {
    const files = new Map();
    for (const f of fileList) files.set(f.webkitRelativePath || f.name, f);
    this.files = rebase(files);
    this.id = 'local';
  }
  async init() {}
  async get(path) {
    const f = this.files.get(path);
    if (!f) throw new Error('No encuentro ' + path);
    return new Uint8Array(await f.arrayBuffer());
  }
}
// Hace las rutas relativas a la carpeta que contiene index.json
function rebase(files) {
  const idx = [...files.keys()].filter((p) => p.endsWith('index.json')).sort((a, b) => a.length - b.length)[0];
  if (!idx) throw new Error('No encuentro index.json en la carpeta');
  const base = idx.slice(0, -'index.json'.length);
  const out = new Map();
  for (const [p, f] of files) if (p.startsWith(base)) out.set(p.slice(base.length), f);
  return out;
}

let source = null;
const inflight = new Map();
function fetchBytes(path, { cache = true } = {}) {
  const key = source.id + '|' + path;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    if (cache) { const hit = await idbGet(key); if (hit) return hit; }
    const bytes = await source.get(path);
    if (cache) idbPut(key, bytes);
    return bytes;
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key));
  return p;
}
const blobUrls = new Map();
async function imageUrl(path) {
  if (blobUrls.has(path)) return blobUrls.get(path);
  const p = fetchBytes(path).then((b) => URL.createObjectURL(new Blob([b], { type: 'image/jpeg' })));
  blobUrls.set(path, p);
  p.catch(() => blobUrls.delete(path));
  return p;
}

/* ---------- estado ---------- */
let index = null;            // {thumb, books}
const books = new Map();     // id -> book
let current = null;          // id del libro visible
let cart = LS.get('cart', []);           // [{b, p, q}]
let overrides = LS.get('overrides', {}); // "id#p" -> true (oculta) / false (visible)
let unchecked = new Set(LS.get('unchecked', []));

const pid = (b, p) => b + '#' + p;
const isHidden = (b, p) => {
  const o = overrides[pid(b, p)];
  if (o !== undefined) return o;
  return (books.get(b)?.pages[p - 1]?.c ?? 0) > HIDE_COLOR;
};
const qtyOf = (b, p) => cart.find((i) => i.b === b && i.p === p)?.q || 0;
function setQty(b, p, q) {
  q = Math.max(0, Math.min(99, q));
  const i = cart.findIndex((x) => x.b === b && x.p === p);
  if (i >= 0) { if (q) cart[i].q = q; else cart.splice(i, 1); }
  else if (q) cart.push({ b, p, q });
  saveCart();
  refreshCard(b, p);
}
function saveCart() { LS.set('cart', cart); renderCart(); renderBookBadges(); }

/* ---------- miniaturas (sprite) ---------- */
function thumbStyle(el, b, p) {
  const t = index.thumb;
  const book = books.get(b);
  const rows = Math.ceil(book.pages.length / t.cols);
  const col = (p - 1) % t.cols, row = Math.floor((p - 1) / t.cols);
  el.style.backgroundSize = `${t.cols * 100}% ${rows * 100}%`;
  el.style.backgroundPosition = `${t.cols > 1 ? (col / (t.cols - 1)) * 100 : 0}% ${rows > 1 ? (row / (rows - 1)) * 100 : 0}%`;
  imageUrl(`${b}/thumbs.jpg`).then((u) => { el.style.backgroundImage = `url("${u}")`; }).catch(() => el.classList.add('err'));
}

/* ---------- libros ---------- */
function renderBooks() {
  const ul = $('#bookList');
  ul.innerHTML = '';
  for (const b of index.books) {
    const li = document.createElement('li');
    li.dataset.id = b.id;
    li.innerHTML = `<input type="checkbox" ${unchecked.has(b.id) ? '' : 'checked'} title="Incluir en aleatorio">
      <span class="name"></span><span class="incart" hidden></span><span class="count">${b.pages.length}</span>`;
    li.querySelector('.name').textContent = b.title;
    ul.append(li);
  }
  renderBookBadges();
}
function renderBookBadges() {
  for (const li of document.querySelectorAll('#bookList li')) {
    const n = cart.filter((i) => i.b === li.dataset.id).reduce((s, i) => s + i.q, 0);
    const s = li.querySelector('.incart');
    s.hidden = !n; s.textContent = n;
    li.classList.toggle('active', li.dataset.id === current);
  }
}
$('#bookList').addEventListener('click', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  if (e.target.matches('input')) {
    e.target.checked ? unchecked.delete(li.dataset.id) : unchecked.add(li.dataset.id);
    LS.set('unchecked', [...unchecked]);
    return;
  }
  showBook(li.dataset.id);
});
$('#booksAll').onclick = () => { unchecked.clear(); LS.set('unchecked', []); renderBooks(); };
$('#booksNone').onclick = () => { unchecked = new Set(index.books.map((b) => b.id)); LS.set('unchecked', [...unchecked]); renderBooks(); };

/* ---------- rejilla ---------- */
function showBook(id) {
  current = id;
  LS.set('current', id);
  const book = books.get(id);
  $('#bookTitle').textContent = book.title;
  const grid = $('#grid');
  grid.innerHTML = '';
  book.pages.forEach((pg, i) => {
    const p = i + 1;
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.p = p;
    card.style.setProperty('--ar', `${pg.w} / ${pg.h}`);
    card.innerHTML = `<div class="thumb" title="Pulsa para añadir"></div>
      <div class="icons"><button data-act="zoom" title="Ver grande">🔍</button><button data-act="hide"></button></div>
      <div class="row"><span class="pg">pág. ${p}</span>
      <span class="qty"><button data-act="minus" aria-label="Quitar">−</button><span></span><button data-act="plus" aria-label="Añadir">+</button></span></div>`;
    thumbStyle(card.querySelector('.thumb'), id, p);
    grid.append(card);
    refreshCard(id, p);
  });
  renderBookBadges();
  $('#viewer').scrollTop = 0;
}
function refreshCard(b, p) {
  if (b !== current) return;
  const card = $(`#grid .card[data-p="${p}"]`); if (!card) return;
  const q = qtyOf(b, p), hid = isHidden(b, p);
  card.classList.toggle('selected', q > 0);
  card.classList.toggle('hiddenpage', hid);
  card.hidden = hid && !$('#showHidden').checked && q === 0;
  card.querySelector('.qty span').textContent = q || '';
  card.querySelector('[data-act=minus]').disabled = !q;
  const hb = card.querySelector('[data-act=hide]');
  hb.textContent = hid ? '👁️' : '🚫';
  hb.title = hid ? 'Marcar como lámina para colorear' : 'Ocultar (no es para colorear)';
}
$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const p = +card.dataset.p, b = current;
  const act = e.target.closest('[data-act]')?.dataset.act || (e.target.closest('.thumb') ? 'plus' : null);
  if (act === 'plus') setQty(b, p, qtyOf(b, p) + 1);
  else if (act === 'minus') setQty(b, p, qtyOf(b, p) - 1);
  else if (act === 'zoom') openPreview(b, p);
  else if (act === 'hide') {
    overrides[pid(b, p)] = !isHidden(b, p);
    LS.set('overrides', overrides);
    refreshCard(b, p);
  }
});
$('#showHidden').onchange = () => current && showBook(current);

/* ---------- vista grande ---------- */
let pv = null;
async function openPreview(b, p) {
  pv = { b, p };
  const book = books.get(b);
  $('#pvLabel').textContent = `${book.title} · pág. ${p}/${book.pages.length}`;
  const img = $('#pvImg');
  img.removeAttribute('src');
  img.classList.add('loading');
  if (!$('#preview').open) $('#preview').showModal();
  try {
    const u = await imageUrl(`${b}/p${String(p).padStart(3, '0')}.jpg`);
    if (pv.b === b && pv.p === p) { img.src = u; img.classList.remove('loading'); }
  } catch (err) { $('#pvLabel').textContent = 'Error: ' + err.message; }
}
$('#pvPrev').onclick = () => pv.p > 1 && openPreview(pv.b, pv.p - 1);
$('#pvNext').onclick = () => pv.p < books.get(pv.b).pages.length && openPreview(pv.b, pv.p + 1);
$('#pvAdd').onclick = () => { setQty(pv.b, pv.p, qtyOf(pv.b, pv.p) + 1); $('#pvAdd').textContent = `+ Añadir (${qtyOf(pv.b, pv.p)})`; };
$('#pvClose').onclick = () => $('#preview').close();
$('#preview').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') $('#pvPrev').click();
  if (e.key === 'ArrowRight') $('#pvNext').click();
});
new MutationObserver(() => { if (pv) $('#pvAdd').textContent = `+ Añadir${qtyOf(pv.b, pv.p) ? ` (${qtyOf(pv.b, pv.p)})` : ''}`; })
  .observe($('#pvLabel'), { childList: true });

/* ---------- cesta ---------- */
function renderCart() {
  const ul = $('#cartList');
  ul.innerHTML = '';
  let total = 0;
  for (const it of cart) {
    const book = books.get(it.b);
    total += it.q;
    const li = document.createElement('li');
    li.innerHTML = `<div class="mini-thumb"></div><div class="info"><b></b><span></span></div>
      <span class="qty"><button data-act="minus">−</button><span>${it.q}</span><button data-act="plus">+</button></span>
      <button class="rm" data-act="rm" title="Quitar">✕</button>`;
    li.querySelector('b').textContent = book ? book.title : '(libro no disponible)';
    li.querySelector('.info span').textContent = `pág. ${it.p}`;
    if (book) thumbStyle(li.querySelector('.mini-thumb'), it.b, it.p);
    li.dataset.b = it.b; li.dataset.p = it.p;
    ul.append(li);
  }
  $('#cartCount').textContent = total ? `(${total} hojas)` : '';
  $('#btnMake').disabled = !total;
  if (!cart.length) ul.innerHTML = '<li class="hint">Pulsa en las láminas o usa 🎲 Aleatorio.</li>';
}
$('#cartList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-b]'); if (!li) return;
  const b = li.dataset.b, p = +li.dataset.p;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'plus') setQty(b, p, qtyOf(b, p) + 1);
  else if (act === 'minus') setQty(b, p, qtyOf(b, p) - 1);
  else if (act === 'rm') setQty(b, p, 0);
  else if (books.has(b)) openPreview(b, p);
});
$('#cart .aside-head').addEventListener('click', (e) => {
  if (e.target.closest('#btnClear')) return;
  const open = $('#cart').classList.toggle('open');
  $('#cartToggle').textContent = open ? '▼ ocultar' : '▲ ver';
});
$('#btnClear').onclick = () => {
  if (!cart.length || !confirm('¿Vaciar la lista?')) return;
  const old = cart; cart = []; saveCart();
  old.forEach((i) => refreshCard(i.b, i.p));
};

/* ---------- aleatorio ---------- */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
$('#btnRandom').onclick = () => {
  const n = Math.max(1, +$('#rndCount').value || 1);
  const copies = Math.max(1, +$('#rndCopies').value || 1);
  const pool = [];
  for (const b of index.books) {
    if (unchecked.has(b.id)) continue;
    b.pages.forEach((_, i) => { if (!isHidden(b.id, i + 1) && !qtyOf(b.id, i + 1)) pool.push([b.id, i + 1]); });
  }
  if (!pool.length) { alert('No quedan láminas disponibles en los libros marcados.'); return; }
  // reparte entre libros: baraja por libro y va cogiendo una de cada en turnos
  const byBook = new Map();
  for (const x of shuffle(pool)) (byBook.get(x[0]) || byBook.set(x[0], []).get(x[0])).push(x);
  const lists = shuffle([...byBook.values()]);
  const picked = [];
  while (picked.length < n && lists.some((l) => l.length)) {
    for (const l of lists) { if (l.length && picked.length < n) picked.push(l.pop()); }
  }
  for (const [b, p] of shuffle(picked)) { cart.push({ b, p, q: copies }); refreshCard(b, p); }
  saveCart();
  if (picked.length < n) alert(`Solo había ${picked.length} láminas nuevas disponibles.`);
};

/* ---------- generar PDF ---------- */
const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}
$('#btnMake').onclick = async () => {
  const items = cart.filter((i) => books.has(i.b));
  if (!items.length) return;
  const btn = $('#btnMake'), prog = $('#makeProgress'), st = $('#makeStatus');
  btn.disabled = true; prog.hidden = false; prog.max = items.length; prog.value = 0;
  st.textContent = 'Descargando láminas…';
  try {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle('Láminas para colorear');
    const bytes = new Array(items.length);
    await pool(items, 4, async (it, k) => {
      bytes[k] = await fetchBytes(`${it.b}/p${String(it.p).padStart(3, '0')}.jpg`);
      prog.value++;
      st.textContent = `Descargando láminas… ${prog.value}/${items.length}`;
    });
    st.textContent = 'Montando el PDF…';
    const imgs = [];
    for (const b of bytes) imgs.push(await doc.embedJpg(b));
    let seq = [];
    items.forEach((it, k) => { for (let c = 0; c < it.q; c++) seq.push(k); });
    if ($('#optShuffle').checked) shuffle(seq);
    const [pw0, ph0] = PAPER[$('#optPaper').value];
    const m = Math.max(0, +$('#optMargin').value || 0) * 72 / 25.4;
    for (const k of seq) {
      const img = imgs[k];
      const land = img.width > img.height;
      const [pw, ph] = land ? [ph0, pw0] : [pw0, ph0];
      const s = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height);
      const w = img.width * s, h = img.height * s;
      doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
    const out = await doc.save();
    const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    const d = new Date();
    const name = `laminas-${d.toISOString().slice(0, 10)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.pdf`;
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    st.innerHTML = `✅ ${seq.length} hojas (${(out.length / 1e6).toFixed(1)} MB). <a target="_blank" href="${url}">Abrir PDF</a> · <a download="${name}" href="${url}">Descargar</a>`;
  } catch (err) {
    console.error(err);
    st.textContent = '❌ Error: ' + err.message;
  } finally {
    btn.disabled = false; prog.hidden = true;
  }
};

/* ---------- arranque ---------- */
async function connect(src) {
  $('#setupStatus').textContent = 'Conectando…';
  source = src;
  await source.init();
  index = JSON.parse(new TextDecoder().decode(await fetchBytes('index.json', { cache: false })));
  books.clear();
  for (const b of index.books) books.set(b.id, b);
  $('#setup').hidden = true;
  $('#app').hidden = false; $('#randomBar').hidden = false; $('#btnSource').hidden = false;
  renderBooks();
  renderCart();
  const last = LS.get('current');
  showBook(books.has(last) ? last : index.books[0].id);
}
function showSetup(msg = '') {
  $('#setup').hidden = false; $('#app').hidden = true; $('#randomBar').hidden = true;
  $('#setupStatus').textContent = msg;
  $('#megaUrl').value = LS.get('mega', '');
}
$('#megaForm').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('#megaUrl').value.trim();
  try { await connect(new MegaSource(url)); LS.set('mega', url); }
  catch (err) { console.error(err); showSetup('❌ ' + err.message); }
};
$('#btnLocal').onclick = () => $('#localInput').click();
$('#localInput').onchange = async (e) => {
  try { await connect(new LocalSource(e.target.files)); }
  catch (err) { console.error(err); showSetup('❌ ' + err.message); }
};
$('#btnSource').onclick = () => showSetup();

(async () => {
  // Se puede pasar el enlace en la URL: ...#mega=https://mega.nz/folder/XXX#clave
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('mega=')) { LS.set('mega', h.slice(5)); history.replaceState(null, '', location.pathname); }
  const saved = LS.get('mega');
  if (!saved) return showSetup();
  try { await connect(new MegaSource(saved)); }
  catch (err) { console.error(err); showSetup('❌ No pude conectar con MEGA: ' + err.message); }
})();
