pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* =====================================================================
 * PROOF-OF-CONCEPT NOTE — multi-book asset loading
 * =====================================================================
 * The dictionary JSON is cross-corpus: a single word's occurrence list can
 * reference several different `book_name`s, so this viewer supports having
 * a PDF, a tag-data file, and a bounding-box CSV loaded per book at once
 * (see booksPdf / tagsByBook / bboxesByBook below, and the #bookSelect
 * dropdown in index.html).
 *
 * For this POC, "loading" a book's assets is a MANUAL step: the reviewer
 * picks a book from the dropdown and clicks "Load PDF for book…" / "Load
 * Tag Data…" / "Load Bounding Boxes…" to pick the matching local file
 * themselves. There's no on-disk convention yet linking a `book_name` to
 * its actual PDF/tag/bbox files.
 *
 * The intended production version replaces this manual step entirely: given
 * a `book_name`, it should automatically resolve and fetch the correct PDF,
 * tag file, and bounding-box CSV (e.g. from a folder/server convention like
 * `<book_name>.pdf`, `<book_name>_tags.txt`, `<book_name>_bboxes.csv`), with
 * no dropdown or manual file-picking required. When that lands, most of the
 * code below this note (bookSelect, openPdfBtn/openTagBtn/openBboxBtn and
 * their <input type="file"> handlers, and updateLoadButtonLabels) can be
 * deleted and replaced with a single "load assets for this book_name"
 * routine triggered automatically whenever the viewer needs them.
 * ===================================================================== */

// ================= dictionary state =================
let dictData = null;        // { word: [ {book_name, page_number, line_number, word_number} ] }
let words = [];             // sorted word list
let currentWordIndex = -1;
let currentOccIndex = 0;
let dictFileHandle = null;  // File System Access handle, if supported/granted
let dictDirty = false;      // true if edits (deletions) haven't been saved yet

// ---- Manual per-book asset storage (POC — see banner note above) ----
// bookName -> { pdfDoc, numPages }
let booksPdf = new Map();
let currentBook = null;     // book name currently shown in viewer
let currentPage = 1;

// bookName -> Map("page_line" -> context sentence)
let tagsByBook = new Map();

// bookName -> Map("page_line" -> {x1,y1,x2,y2})  (normalized 0-1 coordinates)
let bboxesByBook = new Map();
// The bounding box that should be highlighted on the currently rendered page, if any:
// {bookName, pageNum, bbox} or null
let activeHighlight = null;
let highlightEnabled = true;

// ================= pdf viewer state (adapted) =================
let renderScale = 1.4;
let pendingScale = 1.4;
let displayScale = 1;
let renderTask = null;
let panX = 0;
let panY = 0;
let pdfSurface = null;
let zoomCommitTimeout = null;

// ================= elements =================
const el = id => document.getElementById(id);
const openDictBtn = el('openDictBtn');
const saveDictBtn = el('saveDictBtn');
const jumpBox = el('jumpBox');
const wordList = el('wordList');
const statusEl = el('status');

const entryWrap = el('entryWrap');

const bookTag = el('bookTag');
const bookSelect = el('bookSelect');
const openPdfBtn = el('openPdfBtn');
const openTagBtn = el('openTagBtn');
const openBboxBtn = el('openBboxBtn');
const highlightToggle = el('highlightToggle');
const prevPageBtn = el('prevPageBtn');
const nextPageBtn = el('nextPageBtn');
const pageInput = el('pageInput');
const totalPagesLabel = el('totalPages');
const zoomInBtn = el('zoomInBtn');
const zoomOutBtn = el('zoomOutBtn');
const zoomResetBtn = el('zoomResetBtn');
const zoomLabel = el('zoomLabel');
const pdfViewport = el('pdfViewport');

function updateStatus(msg, isError){
  statusEl.textContent = msg;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

// ================= dictionary loading =================
function loadDictFromText(text){
  const parsed = JSON.parse(text);
  dictData = parsed;
  words = Object.keys(dictData).sort((a,b) => a.localeCompare(b, 'hi'));
  if (words.length === 0){
    updateStatus('No entries found in that file.', true);
    return false;
  }
  populateWordList();
  populateBookSelect();
  currentWordIndex = 0;
  dictDirty = false;
  saveDictBtn.disabled = true;
  renderWord();
  return true;
}

const dictInput = document.createElement('input');
dictInput.type = 'file'; dictInput.accept = 'application/json,.json';
dictInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  dictFileHandle = null; // plain <input> gives no writable handle
  try {
    const text = await file.text();
    if (loadDictFromText(text)){
      updateStatus(`Loaded ${words.length.toLocaleString()} entries (edits will download as a new file — your browser doesn't support in-place saving)`);
    }
  } catch(err){
    updateStatus('Could not parse JSON: ' + err.message, true);
  }
});

openDictBtn.addEventListener('click', async () => {
  if (window.showOpenFilePicker){
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{description: 'JSON dictionary', accept: {'application/json': ['.json']}}]
      });
      const file = await handle.getFile();
      const text = await file.text();
      dictFileHandle = handle;
      if (loadDictFromText(text)){
        updateStatus(`Loaded ${words.length.toLocaleString()} entries — saves will write back to ${file.name}`);
      }
      return;
    } catch(err){
      if (err.name === 'AbortError') return;
      // fall through to plain input on other errors
    }
  }
  dictInput.click();
});

function markDictDirty(){
  dictDirty = true;
  saveDictBtn.disabled = false;
  updateStatus('Unsaved changes to dictionary', false);
}

async function saveDictionary(){
  if (!dictData) return;
  const json = JSON.stringify(dictData, null, 2);
  if (dictFileHandle){
    try {
      const writable = await dictFileHandle.createWritable();
      await writable.write(json);
      await writable.close();
      dictDirty = false;
      saveDictBtn.disabled = true;
      updateStatus('Dictionary saved');
    } catch(err){
      updateStatus('Could not save file: ' + err.message, true);
    }
  } else {
    const blob = new Blob([json], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dictionary.json';
    a.click();
    URL.revokeObjectURL(a.href);
    dictDirty = false;
    saveDictBtn.disabled = true;
    updateStatus('Dictionary downloaded as dictionary.json');
  }
}
saveDictBtn.addEventListener('click', saveDictionary);

window.addEventListener('beforeunload', e => {
  if (dictDirty){ e.preventDefault(); e.returnValue=''; }
});

function populateWordList(){
  wordList.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const w of words){
    const opt = document.createElement('option');
    opt.value = w;
    frag.appendChild(opt);
  }
  wordList.appendChild(frag);
}

function populateBookSelect(){
  const books = new Set();
  for (const w of words){
    for (const occ of dictData[w]){
      if (occ.book_name) books.add(occ.book_name);
    }
  }
  bookSelect.innerHTML = '';
  for (const b of [...books].sort()){
    const opt = document.createElement('option');
    opt.value = b; opt.textContent = b;
    bookSelect.appendChild(opt);
  }
  bookSelect.disabled = books.size === 0;
  openPdfBtn.disabled = books.size === 0;
  openTagBtn.disabled = books.size === 0;
  openBboxBtn.disabled = books.size === 0;
  updateLoadButtonLabels();
}

// Reflects, for the book currently selected in the dropdown, whether a PDF /
// tag file / bbox CSV has already been loaded for it — so the toolbar makes
// clear that loading again will REPLACE what's there, not add it for the first time.
// POC: this whole function exists only because loading is manual (see banner
// note at top of file). Once assets auto-resolve by book_name, this becomes
// unnecessary — there's nothing for a "Load…" button to be relabeled.
function updateLoadButtonLabels(){
  const book = bookSelect.value;
  openPdfBtn.textContent = (book && booksPdf.has(book))
    ? '✓ PDF loaded — change…'
    : 'Load PDF for book…';
  openTagBtn.textContent = (book && tagsByBook.has(book))
    ? '✓ Tag data loaded — change…'
    : 'Load Tag Data…';
  openBboxBtn.textContent = (book && bboxesByBook.has(book))
    ? '✓ Bounding boxes loaded — change…'
    : 'Load Bounding Boxes…';
}

jumpBox.addEventListener('change', () => {
  const idx = words.indexOf(jumpBox.value.trim());
  if (idx === -1){
    updateStatus(`"${jumpBox.value.trim()}" not found in dictionary`, true);
    return;
  }
  currentWordIndex = idx;
  renderWord();
  jumpBox.value = '';
});

// ================= entry rendering =================
function renderWord(){
  if (currentWordIndex < 0 || currentWordIndex >= words.length) return;
  const word = words[currentWordIndex];
  const occurrences = dictData[word] || [];
  currentOccIndex = 0;

  entryWrap.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'word-card';
  card.innerHTML = `
    <button id="deleteWordBtn" class="delete-word-btn" title="Delete this entry from the dictionary">Delete entry</button>
    <div class="word-index">Entry ${currentWordIndex + 1} of ${words.length}</div>
    <div class="word-display">${escapeHtml(word)}</div>
    <div class="word-nav">
      <button id="prevWordBtn" ${currentWordIndex === 0 ? 'disabled' : ''}>◀ Previous</button>
      <button id="randomWordBtn" ${words.length <= 1 ? 'disabled' : ''} title="Jump to a random entry">🎲 Random</button>
      <span class="goto">#<input id="wordGoto" type="number" min="1" max="${words.length}" value="${currentWordIndex + 1}"></span>
      <button id="nextWordBtn" ${currentWordIndex === words.length - 1 ? 'disabled' : ''}>Next ▶</button>
    </div>
    <div class="occ-heading">Occurrences (${occurrences.length})</div>
    <div id="occList"></div>
  `;
  entryWrap.appendChild(card);

  card.querySelector('#prevWordBtn').addEventListener('click', () => { currentWordIndex--; renderWord(); });
  card.querySelector('#nextWordBtn').addEventListener('click', () => { currentWordIndex++; renderWord(); });
  card.querySelector('#randomWordBtn').addEventListener('click', goToRandomWord);
  card.querySelector('#deleteWordBtn').addEventListener('click', () => deleteCurrentWord(word));
  card.querySelector('#wordGoto').addEventListener('change', (e) => {
    let v = parseInt(e.target.value, 10);
    if (isNaN(v)) return;
    v = Math.min(words.length, Math.max(1, v));
    currentWordIndex = v - 1;
    renderWord();
  });

  const occList = card.querySelector('#occList');
  if (occurrences.length === 0){
    occList.innerHTML = `<div class="placeholder" style="height:auto;padding:16px;color:var(--muted);font-size:13px;">No occurrences remain for this entry.</div>`;
  }
  occurrences.forEach((occ, i) => {
    const row = document.createElement('div');
    row.className = 'occ-row' + (i === 0 ? ' active' : '');
    const hasPdf = booksPdf.has(occ.book_name);
    const hasBboxData = bboxesByBook.has(occ.book_name);
    row.innerHTML = `
      <div class="occ-row-top">
        <span class="pdf-dot ${hasPdf ? 'ready' : ''}" title="PDF loaded"></span>
        <span class="bbox-dot ${hasBboxData ? 'ready' : ''}" title="Bounding boxes loaded"></span>
        <span class="book-loc">${escapeHtml(occ.book_name || 'Unknown')}<span class="loc">p.${occ.page_number ?? '–'} · l.${occ.line_number ?? '–'} · #${occ.word_number ?? '–'}</span></span>
        <div class="fill"></div>
        <button class="occ-delete-btn" title="Delete this occurrence">✕</button>
      </div>
      <div class="occ-context"></div>
      <div class="occ-bbox-status"></div>
      <div class="occ-meaning-wrap">
        <label class="occ-meaning-label">Scholar's notes<span class="occ-meaning-hint"></span></label>
        <textarea class="occ-meaning" rows="2" placeholder="(meaning, part of speech, number, tense, pronunciation, etc.)">${escapeHtml(occ.meaning || '')}</textarea>
      </div>
    `;
    applyContextMarkup(row.querySelector('.occ-context'), occ);
    applyBboxStatus(row.querySelector('.occ-bbox-status'), occ);
    row.addEventListener('click', () => selectOccurrence(occ, i, occList));
    row.querySelector('.occ-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteOccurrence(word, i);
    });
    const quickBtn = row.querySelector('.quick-tag-btn');
    if (quickBtn){
      quickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadTagDataForBook(quickBtn.dataset.book);
      });
    }
    const quickBboxBtn = row.querySelector('.quick-bbox-btn');
    if (quickBboxBtn){
      quickBboxBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadBboxDataForBook(quickBboxBtn.dataset.book);
      });
    }
    const meaningEl = row.querySelector('.occ-meaning');
    if (meaningEl){
      // Don't let interacting with the textarea re-trigger page navigation —
      // a scholar filling in meanings shouldn't have the PDF jump on every click.
      meaningEl.addEventListener('click', e => e.stopPropagation());
      meaningEl.addEventListener('mousedown', e => e.stopPropagation());
      let meaningDirtyTimeout = null;
      meaningEl.addEventListener('input', () => {
        occ.meaning = meaningEl.value;
        clearTimeout(meaningDirtyTimeout);
        meaningDirtyTimeout = setTimeout(markDictDirty, 300);
      });
    }
    occList.appendChild(row);
  });

  if (occurrences.length){
    selectOccurrence(occurrences[0], 0, occList);
  } else {
    showPdfPlaceholder('This entry has no recorded occurrences.');
  }

  jumpBox.value = '';
}

function applyContextMarkup(contextEl, occ){
  const text = getContextText(occ.book_name, occ.page_number, occ.line_number);
  if (text === undefined){
    contextEl.classList.add('occ-context-empty');
    contextEl.innerHTML = `Tag data not loaded for "${escapeHtml(occ.book_name || 'this book')}" — <button class="quick-tag-btn" data-book="${escapeHtml(occ.book_name || '')}">Load tag data…</button>`;
    const btn = contextEl.querySelector('.quick-tag-btn');
    if (btn){
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadTagDataForBook(btn.dataset.book);
      });
    }
  } else if (text === null){
    contextEl.classList.add('occ-context-empty');
    contextEl.classList.remove('occ-context-filled');
    contextEl.textContent = `No matching line found in the tag data for p.${occ.page_number ?? '–'} · l.${occ.line_number ?? '–'}.`;
  } else {
    contextEl.classList.remove('occ-context-empty');
    contextEl.innerHTML = `<span class="context-label">Context: </span>${escapeHtml(text)}`;
  }
}

async function selectOccurrence(occ, i, occList){
  currentOccIndex = i;
  [...occList.children].forEach((r, idx) => r.classList.toggle('active', idx === i));
  const bookName = occ.book_name;
  const pageNum = occ.page_number ?? null;
  bookTag.textContent = bookName || '';

  updateActiveHighlightFromCurrentOccurrence();

  if (!booksPdf.has(bookName)){
    showPdfPlaceholder(`PDF for "${bookName}" is not loaded yet.`, bookName);
    return;
  }
  currentBook = bookName;
  bookSelect.value = bookName;
  updateLoadButtonLabels();
  const entry = booksPdf.get(bookName);
  const target = Math.min(entry.numPages, Math.max(1, pageNum || 1));
  await goToPage(target);
  centerOnHighlightIfNeeded();
}

function goToRandomWord(){
  if (words.length <= 1) return;
  let idx;
  do { idx = Math.floor(Math.random() * words.length); } while (idx === currentWordIndex);
  currentWordIndex = idx;
  renderWord();
}

function deleteCurrentWord(word){
  const count = (dictData[word] || []).length;
  const ok = confirm(`Delete "${word}" and all ${count} occurrence(s) from the dictionary? This can't be undone unless you close without saving.`);
  if (!ok) return;

  delete dictData[word];
  words.splice(currentWordIndex, 1);
  markDictDirty();
  populateWordList();
  populateBookSelect();

  if (words.length === 0){
    entryWrap.innerHTML = '<div class="placeholder">All entries have been deleted.</div>';
    showPdfPlaceholder('No entries remain.');
    updateStatus(`Deleted "${word}" — the dictionary is now empty`);
    return;
  }
  if (currentWordIndex >= words.length) currentWordIndex = words.length - 1;
  updateStatus(`Deleted "${word}" — ${words.length.toLocaleString()} entries remain`);
  renderWord();
}

function deleteOccurrence(word, occIndex){
  const occurrences = dictData[word];
  if (!occurrences || !occurrences[occIndex]) return;
  occurrences.splice(occIndex, 1);
  markDictDirty();
  populateBookSelect();
  updateStatus(`Removed occurrence — ${occurrences.length} remain for "${word}"`);
  renderWord();
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ================= PDF loading per book =================
// POC: manual file picker keyed to whichever book is selected in the
// dropdown. Production version: auto-fetch by book_name — see banner note
// at the top of this file. Delete this block (and openPdfBtn's wiring in
// index.html) once that's in place.
const pdfInput = document.createElement('input');
pdfInput.type = 'file'; pdfInput.accept = 'application/pdf';
pdfInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const targetBook = bookSelect.value;
  updateStatus(`Loading PDF for "${targetBook}"…`);
  try {
    const buf = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({data: buf}).promise;
    booksPdf.set(targetBook, {pdfDoc, numPages: pdfDoc.numPages});
    updateStatus(`Loaded PDF for "${targetBook}" (${pdfDoc.numPages} pages)`);
    enableNavAndZoom();
    updateLoadButtonLabels();
    // If this is the book of the currently active occurrence, jump straight there
    const word = words[currentWordIndex];
    const occ = word ? (dictData[word] || [])[currentOccIndex] : null;
    if (occ && occ.book_name === targetBook){
      currentBook = targetBook;
      const target = Math.min(pdfDoc.numPages, Math.max(1, occ.page_number || 1));
      await goToPage(target);
      centerOnHighlightIfNeeded();
    }
    refreshOccList();
  } catch(err){
    updateStatus('Could not load PDF: ' + err.message, true);
  }
});
openPdfBtn.addEventListener('click', () => {
  if (!bookSelect.value){
    updateStatus('No book selected.', true);
    return;
  }
  pdfInput.click();
});

// ================= tag data (context sentences) loading =================
// POC: manual file picker keyed to whichever book is selected in the
// dropdown. Production version: auto-fetch by book_name — see banner note
// at the top of this file. Delete this block (and openTagBtn's wiring in
// index.html) once that's in place.
// Expects lines like: [PAGE 0091, LINE 006] एण-खुर-खंडिआपंडु-जच्च-कच्चूर-चुण्णमुण्णमइ ।
const TAG_LINE_RE = /\[\s*PAGE\s+(\d+)\s*,\s*LINE\s+(\d+)\s*\]\s*([^\r\n]*)/gi;

const tagInput = document.createElement('input');
tagInput.type = 'file'; tagInput.accept = 'text/plain,.txt';
tagInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const targetBook = bookSelect.value;
  updateStatus(`Loading tag data for "${targetBook}"…`);
  try {
    const text = await file.text();
    const map = new Map();
    let match;
    TAG_LINE_RE.lastIndex = 0;
    while ((match = TAG_LINE_RE.exec(text)) !== null){
      const page = parseInt(match[1], 10);
      const line = parseInt(match[2], 10);
      const sentence = match[3].trim();
      if (!isNaN(page) && !isNaN(line)){
        map.set(`${page}_${line}`, sentence);
      }
    }
    if (map.size === 0){
      updateStatus(`No "[PAGE ####, LINE ####]" entries found in that file.`, true);
      return;
    }
    tagsByBook.set(targetBook, map);
    updateStatus(`Loaded tag data for "${targetBook}" (${map.size.toLocaleString()} lines)`);
    updateLoadButtonLabels();
    refreshOccList();
  } catch(err){
    updateStatus('Could not read tag data file: ' + err.message, true);
  }
});
openTagBtn.addEventListener('click', () => {
  if (!bookSelect.value){
    updateStatus('No book selected.', true);
    return;
  }
  tagInput.click();
});

function loadTagDataForBook(bookName){
  if (!bookName) return;
  bookSelect.value = bookName;
  updateLoadButtonLabels();
  tagInput.click();
}

// ================= bounding box (line coordinates) loading =================
// POC: manual file picker keyed to whichever book is selected in the
// dropdown. Production version: auto-fetch by book_name — see banner note
// at the top of this file. Delete this block (and openBboxBtn's wiring in
// index.html) once that's in place.
// Expects a CSV with header: page_number,line_number,x1,y1,x2,y2
// x1,y1 = top-left corner, x2,y2 = bottom-right corner, normalized 0-1
// (fraction of page width/height) — produced by run_ocr_batch.py / process_ocr_shards.py.
function parseBboxCsv(text){
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return new Map();

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const col = {
    page: header.indexOf('page_number'),
    line: header.indexOf('line_number'),
    x1: header.indexOf('x1'),
    y1: header.indexOf('y1'),
    x2: header.indexOf('x2'),
    y2: header.indexOf('y2'),
  };
  if (Object.values(col).some(idx => idx === -1)){
    throw new Error('CSV must have columns: page_number, line_number, x1, y1, x2, y2');
  }

  const map = new Map();
  for (let i = 1; i < lines.length; i++){
    const cols = lines[i].split(',');
    const page = parseInt(cols[col.page], 10);
    const line = parseInt(cols[col.line], 10);
    const x1 = parseFloat(cols[col.x1]);
    const y1 = parseFloat(cols[col.y1]);
    const x2 = parseFloat(cols[col.x2]);
    const y2 = parseFloat(cols[col.y2]);
    if ([page, line, x1, y1, x2, y2].some(v => Number.isNaN(v))) continue;
    map.set(`${page}_${line}`, {x1, y1, x2, y2});
  }
  return map;
}

const bboxInput = document.createElement('input');
bboxInput.type = 'file'; bboxInput.accept = 'text/csv,.csv';
bboxInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const targetBook = bookSelect.value;
  updateStatus(`Loading bounding boxes for "${targetBook}"…`);
  try {
    const text = await file.text();
    const map = parseBboxCsv(text);
    if (map.size === 0){
      updateStatus('No valid bounding-box rows found in that file.', true);
      return;
    }
    bboxesByBook.set(targetBook, map);
    updateStatus(`Loaded bounding boxes for "${targetBook}" (${map.size.toLocaleString()} lines)`);
    updateLoadButtonLabels();
    refreshOccList();
    if (currentBook === targetBook){
      updateActiveHighlightFromCurrentOccurrence();
      renderHighlightOverlay(currentPage);
    }
  } catch(err){
    updateStatus('Could not read bounding box CSV: ' + err.message, true);
  }
});
openBboxBtn.addEventListener('click', () => {
  if (!bookSelect.value){
    updateStatus('No book selected.', true);
    return;
  }
  bboxInput.click();
});

function loadBboxDataForBook(bookName){
  if (!bookName) return;
  bookSelect.value = bookName;
  updateLoadButtonLabels();
  bboxInput.click();
}

// Returns: {x1,y1,x2,y2} (bbox found), null (bbox data loaded but no match), or
// undefined (no bbox data loaded for this book yet)
function getBoundingBox(bookName, pageNum, lineNum){
  const map = bboxesByBook.get(bookName);
  if (!map) return undefined;
  const key = `${pageNum}_${lineNum}`;
  return map.has(key) ? map.get(key) : null;
}

function applyBboxStatus(statusEl, occ){
  const bbox = getBoundingBox(occ.book_name, occ.page_number, occ.line_number);
  if (bbox === undefined){
    statusEl.innerHTML = `Bounding boxes not loaded for "${escapeHtml(occ.book_name || 'this book')}" — <button class="quick-bbox-btn" data-book="${escapeHtml(occ.book_name || '')}">Load…</button>`;
    const btn = statusEl.querySelector('.quick-bbox-btn');
    if (btn){
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadBboxDataForBook(btn.dataset.book);
      });
    }
  } else if (bbox === null){
    statusEl.textContent = `No bounding box found for p.${occ.page_number ?? '–'} · l.${occ.line_number ?? '–'}`;
  } else {
    statusEl.innerHTML = '';
  }
}

// Recomputes activeHighlight (the box to draw/center on) from whichever
// occurrence is currently selected. Called whenever the selection changes,
// or when bbox data finishes loading for the active book.
function updateActiveHighlightFromCurrentOccurrence(){
  const word = words[currentWordIndex];
  const occ = word ? (dictData[word] || [])[currentOccIndex] : null;
  if (!occ){ activeHighlight = null; return; }
  const bbox = getBoundingBox(occ.book_name, occ.page_number, occ.line_number);
  activeHighlight = (bbox && occ.page_number)
    ? {bookName: occ.book_name, pageNum: occ.page_number, bbox}
    : null;
}

// Draws (or clears) the highlight box for the given page. Only draws if the
// highlight belongs to the book/page currently on screen. Position is set in
// unscaled canvas pixel coordinates — because the overlay lives inside
// #pdfSurface, it pans/zooms in lockstep with the page automatically.
function renderHighlightOverlay(pageNum){
  if (!pdfSurface) return;
  const existing = pdfSurface.querySelector('.bbox-highlight');
  if (existing) existing.remove();

  if (!highlightEnabled || !activeHighlight) return;
  if (activeHighlight.pageNum !== pageNum || activeHighlight.bookName !== currentBook) return;

  const canvas = pdfSurface.querySelector('canvas');
  if (!canvas) return;

  const {x1, y1, x2, y2} = activeHighlight.bbox;
  const pad = 0.004; // small padding so the box doesn't hug the glyphs too tightly
  const left = Math.max(0, x1 - pad) * canvas.width;
  const top = Math.max(0, y1 - pad) * canvas.height;
  const right = Math.min(1, x2 + pad) * canvas.width;
  const bottom = Math.min(1, y2 + pad) * canvas.height;

  const box = document.createElement('div');
  box.className = 'bbox-highlight';
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${Math.max(1, right - left)}px`;
  box.style.height = `${Math.max(1, bottom - top)}px`;
  pdfSurface.appendChild(box);
}

// Pans the viewport so the active highlight is centered on screen. Only
// called right after navigating to a new occurrence — not on every re-render
// (e.g. during zooming), so it never fights the scholar's own panning.
function centerOnHighlightIfNeeded(){
  if (!highlightEnabled || !activeHighlight || !pdfSurface) return;
  if (activeHighlight.pageNum !== currentPage || activeHighlight.bookName !== currentBook) return;

  const canvas = pdfSurface.querySelector('canvas');
  if (!canvas) return;

  const {x1, y1, x2, y2} = activeHighlight.bbox;
  const cx = ((x1 + x2) / 2) * canvas.width;
  const cy = ((y1 + y2) / 2) * canvas.height;
  panX = (canvas.width / 2 - cx) * displayScale;
  panY = (canvas.height / 2 - cy) * displayScale;
  updatePdfSurfaceTransform();
}

highlightToggle.addEventListener('change', () => {
  highlightEnabled = highlightToggle.checked;
  if (pdfSurface) renderHighlightOverlay(currentPage);
});

// Returns: string (context found), null (tag data loaded but no match), or undefined (no tag data for this book yet)
function getContextText(bookName, pageNum, lineNum){
  const map = tagsByBook.get(bookName);
  if (!map) return undefined;
  const key = `${pageNum}_${lineNum}`;
  return map.has(key) ? map.get(key) : null;
}

function refreshOccList(){
  document.querySelectorAll('#occList .occ-row').forEach((row, i) => {
    const word = words[currentWordIndex];
    const occ = (dictData[word] || [])[i];
    if (!occ) return;
    const dot = row.querySelector('.pdf-dot');
    if (dot) dot.classList.toggle('ready', booksPdf.has(occ.book_name));
    const bboxDot = row.querySelector('.bbox-dot');
    if (bboxDot) bboxDot.classList.toggle('ready', bboxesByBook.has(occ.book_name));
    const contextEl = row.querySelector('.occ-context');
    if (contextEl) applyContextMarkup(contextEl, occ);
    const bboxStatusEl = row.querySelector('.occ-bbox-status');
    if (bboxStatusEl) applyBboxStatus(bboxStatusEl, occ);
  });
}

function enableNavAndZoom(){
  prevPageBtn.disabled = false; nextPageBtn.disabled = false;
  zoomInBtn.disabled = false; zoomOutBtn.disabled = false; zoomResetBtn.disabled = false;
  pageInput.disabled = false;
}

// ================= PDF rendering (adapted from OCR tool) =================
function showPdfPlaceholder(message, offerBook){
  let extra = '';
  if (offerBook){
    extra = `<div style="margin-top:10px;"><button id="quickLoadBtn">Load PDF for "${escapeHtml(offerBook)}"…</button></div>`;
  }
  pdfViewport.innerHTML = `<div class="placeholder"><div>${escapeHtml(message)}${extra}</div></div>`;
  pdfSurface = null;
  totalPagesLabel.textContent = '–';
  pageInput.value = '';
  if (offerBook){
    document.getElementById('quickLoadBtn').addEventListener('click', () => {
      bookSelect.value = offerBook;
      updateLoadButtonLabels();
      pdfInput.click();
    });
  }
}

function updatePdfSurfaceTransform(){
  if (!pdfSurface) return;
  pdfSurface.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${displayScale})`;
}

function scheduleZoomCommit(){
  clearTimeout(zoomCommitTimeout);
  zoomCommitTimeout = setTimeout(() => {
    renderScale = pendingScale;
    displayScale = 1;
    zoomLabel.textContent = Math.round((renderScale/1.4)*100) + '%';
    renderPdfPage(currentPage);
  }, 100);
}

async function renderPdfPage(num){
  const entry = currentBook ? booksPdf.get(currentBook) : null;
  if (!entry) return;
  const page = await entry.pdfDoc.getPage(num);
  const viewport = page.getViewport({scale: renderScale});
  pdfViewport.innerHTML = '';
  pdfSurface = document.createElement('div');
  pdfSurface.id = 'pdfSurface';
  pdfSurface.style.transition = 'transform 160ms ease-out';
  pdfSurface.style.transform = `translate(${panX}px, ${panY}px) scale(${displayScale})`;
  const canvas = document.createElement('canvas');
  canvas.id = 'pdfCanvas';
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  pdfSurface.appendChild(canvas);
  pdfViewport.appendChild(pdfSurface);
  if (renderTask) { try { renderTask.cancel(); } catch(e){} }
  renderTask = page.render({canvasContext: ctx, viewport});
  try { await renderTask.promise; } catch(e){ /* cancelled render, ignore */ }
  renderHighlightOverlay(num);
}

// ---- Zoom ----
function setZoom(scale){
  pendingScale = Math.min(4, Math.max(0.4, scale));
  displayScale = pendingScale / renderScale;
  if (pdfSurface){
    updatePdfSurfaceTransform();
  }
  zoomLabel.textContent = Math.round((pendingScale/1.4)*100) + '%';
  scheduleZoomCommit();
}
zoomInBtn.addEventListener('click', () => setZoom(pendingScale * 1.2));
zoomOutBtn.addEventListener('click', () => setZoom(pendingScale / 1.2));
zoomResetBtn.addEventListener('click', () => setZoom(1.4));

pdfViewport.addEventListener('wheel', e => {
  if (!currentBook) return;
  e.preventDefault();
  setZoom(pendingScale * (e.deltaY < 0 ? 1.08 : 1/1.08));
}, {passive:false});

// ---- Pan (drag to scroll) ----
let dragging = false, dragStartX=0, dragStartY=0, startPanX=0, startPanY=0;
pdfViewport.addEventListener('mousedown', e => {
  if (e.button !== 0 || !pdfSurface) return;
  dragging = true;
  pdfViewport.classList.add('grabbing');
  dragStartX = e.clientX; dragStartY = e.clientY;
  startPanX = panX; startPanY = panY;
  e.preventDefault();
});
pdfViewport.addEventListener('mouseleave', () => {
  dragging = false;
  pdfViewport.classList.remove('grabbing');
});
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  panX = startPanX + (e.clientX - dragStartX);
  panY = startPanY + (e.clientY - dragStartY);
  updatePdfSurfaceTransform();
});
window.addEventListener('mouseup', () => { dragging=false; pdfViewport.classList.remove('grabbing'); });

// ---- Page navigation (manual override within the loaded book) ----
async function goToPage(num){
  const entry = currentBook ? booksPdf.get(currentBook) : null;
  if (!entry) return;
  num = Math.min(entry.numPages, Math.max(1, num));
  currentPage = num;
  pageInput.value = num;
  totalPagesLabel.textContent = entry.numPages;
  prevPageBtn.disabled = num <= 1;
  nextPageBtn.disabled = num >= entry.numPages;
  panX = 0; panY = 0;
  enableNavAndZoom();
  await renderPdfPage(num);
}
prevPageBtn.addEventListener('click', () => goToPage(currentPage - 1));
nextPageBtn.addEventListener('click', () => goToPage(currentPage + 1));
pageInput.addEventListener('change', () => goToPage(parseInt(pageInput.value, 10) || 1));

bookSelect.addEventListener('change', () => {
  updateLoadButtonLabels();
  const b = bookSelect.value;
  if (booksPdf.has(b)){
    currentBook = b;
    bookTag.textContent = b;
    goToPage(1);
  }
});

// ---- keyboard: left/right move between words, unless typing ----
window.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!words.length) return;
  if (e.key === 'ArrowLeft' && currentWordIndex > 0){ currentWordIndex--; renderWord(); }
  if (e.key === 'ArrowRight' && currentWordIndex < words.length - 1){ currentWordIndex++; renderWord(); }
});