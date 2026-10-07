/* ui-design · behaviour
   The few components that need script (paged, filterable tables, forms that post, sums a
   visitor can change) on any page. Plain pages call enhance(); the agent layout calls it on
   each answer.
     <script type="module">import { enhance } from './src/ui.mjs'; enhance();</script> */
import { esc, tableRow, tableHead, calcValues, formatNumber, WORDS } from './render.mjs';

const each = (el, sel, f) => (el.matches?.(sel) ? [el] : [...el.querySelectorAll(sel)]).forEach(f);
export function enhance(el = document) {
  if (!el) return;
  each(el, '[data-ui-table]', table);
  each(el, '[data-ui-form]', formBlock);
  each(el, '[data-ui-calc]', calc);
  each(el, 'table.ui-dtable', dtable);
  each(el, '.ui-panes', panes);
  drawers();
}

/* a panels grid: drag the gaps between columns and rows to resize. Sizes are fractions; a ui-resize
   event carries them ({ cols: [..], rows: [..] }) so an app can save the layout per person, and
   data-sizes="cols;rows" (for example "2,1;1,1") restores one. data-fixed turns the handles off. */
function panes(g) {
  if (g.dataset.wired || g.hasAttribute('data-fixed')) return; g.dataset.wired = '1';
  const n = k => Math.max(1, Number(g.dataset[k]) || (k === 'cols' ? 2 : 1));
  const [c0, r0] = (g.dataset.sizes || '').split(';').map(x => x ? x.split(',').map(Number) : null);
  const S = { cols: c0?.length === n('cols') ? c0 : Array(n('cols')).fill(1), rows: r0?.length === n('rows') ? r0 : Array(n('rows')).fill(1) };
  const apply = () => {
    g.style.setProperty('--ui-panes-cols', S.cols.map(f => `minmax(0,${f.toFixed(3)}fr)`).join(' '));
    g.style.setProperty('--ui-panes-rows', S.rows.map(f => `minmax(0,${f.toFixed(3)}fr)`).join(' '));
    place();
  };
  const handles = [];
  const place = () => {
    const gap = parseFloat(getComputedStyle(g).columnGap) || 0, W = g.clientWidth, H = g.clientHeight;
    for (const h of handles) {
      const fr = S[h.axis], tot = fr.reduce((a, b) => a + b, 0), size = (h.axis === 'cols' ? W : H) - gap * (fr.length - 1);
      const at = fr.slice(0, h.i + 1).reduce((a, b) => a + b, 0) / tot * size + gap * h.i + gap / 2;
      h.el.style[h.axis === 'cols' ? 'left' : 'top'] = at + 'px';
    }
  };
  for (const axis of ['cols', 'rows']) for (let i = 0; i < S[axis].length - 1; i++) {
    const el = document.createElement('div'); el.className = `ui-gutter ${axis === 'cols' ? 'is-col' : 'is-row'}`; el.setAttribute('aria-hidden', 'true');
    const h = { el, axis, i }; handles.push(h); g.appendChild(el);
    el.addEventListener('pointerdown', e => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('is-on');
      const fr = S[axis], start = axis === 'cols' ? e.clientX : e.clientY, a = fr[i], b = fr[i + 1];
      const px = ((axis === 'cols' ? g.clientWidth : g.clientHeight) - (parseFloat(getComputedStyle(g).columnGap) || 0) * (fr.length - 1)) / fr.reduce((x, y) => x + y, 0);
      const min = (a + b) * 0.15, move = ev => { const d = Math.min(b - min, Math.max(min - a, ((axis === 'cols' ? ev.clientX : ev.clientY) - start) / px)); fr[i] = a + d; fr[i + 1] = b - d; apply(); };
      const up = () => { el.classList.remove('is-on'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); g.dispatchEvent(new CustomEvent('ui-resize', { detail: { cols: [...S.cols], rows: [...S.rows] } })); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => { S[axis].fill(1); apply(); g.dispatchEvent(new CustomEvent('ui-resize', { detail: { cols: [...S.cols], rows: [...S.rows] } })); });
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(g);
  apply();
}

/* drawers: a button with data-ui-drawer="id" opens and closes #id; Escape or a [data-ui-close] inside closes it */
let drawersWired = false;
function drawers() {
  if (drawersWired || typeof document === 'undefined') return; drawersWired = true;
  const setOpen = (d, on) => { d.classList.toggle('is-open', on); document.querySelectorAll(`[data-ui-drawer="${d.id}"]`).forEach(b => b.setAttribute('aria-expanded', String(on))); if (on) d.querySelector('button,a,[tabindex]')?.focus({ preventScroll: true }); };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-ui-drawer]'); if (b) { const d = document.getElementById(b.dataset.uiDrawer); if (d) setOpen(d, !d.classList.contains('is-open')); return; }
    const x = e.target.closest('.ui-drawer [data-ui-close]'); if (x) setOpen(x.closest('.ui-drawer'), false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.ui-drawer.is-open:not(.is-static)').forEach(d => setOpen(d, false)); });
}

/* a data table: th[data-k] sorts by its column (numbers as numbers), tr[data-href] opens on click.
   Sorting is in the page; set data-server on the table to handle sorting yourself (a ui-sort event fires). */
function dtable(t) {
  if (t.dataset.wired) return; t.dataset.wired = '1';
  t.addEventListener('click', e => {
    const th = e.target.closest('th[data-k]');
    if (th) {
      const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
      t.querySelectorAll('th[aria-sort]').forEach(x => x.removeAttribute('aria-sort')); th.setAttribute('aria-sort', dir);
      t.dispatchEvent(new CustomEvent('ui-sort', { detail: { key: th.dataset.k, dir } }));
      if (t.hasAttribute('data-server')) return;
      const k = [...th.parentNode.children].indexOf(th), body = t.tBodies[0], val = r => { const c = r.cells[k]; const v = c?.dataset.v ?? c?.textContent.trim() ?? ''; const n = Number(String(v).replace(/[^\d.-]/g, '')); return v !== '' && /\d/.test(v) && !Number.isNaN(n) && /^[^a-z]*$/i.test(v) ? n : v.toLowerCase(); };
      [...body.rows].sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (dir === 'ascending' ? 1 : -1); }).forEach(r => body.appendChild(r));
      return;
    }
    const tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a,button,input,select,label')) { if (e.metaKey || e.ctrlKey) open(tr.dataset.href); else location.href = tr.dataset.href; }
  });
}

function table(box) {
  if (box.dataset.wired) return; box.dataset.wired = '1';
  const d = JSON.parse(box.querySelector('script').textContent), S = { f: '', q: '', page: 1 };
  const w = { ...WORDS, ...(d.words || {}) }, cols = d.cols || 3;
  /* the filter shown as pressed on load is the one applied */
  const on = box.querySelector('[data-f][aria-pressed=true]'); if (on) S.f = on.dataset.f;
  const draw = () => {
    const l = d.rows.filter(r => (!S.f || d.filterCol == null || String(r[d.filterCol]).split(' ').includes(S.f)) && (!S.q || r.join(' ').toLowerCase().includes(S.q)));
    const last = Math.max(1, Math.ceil(l.length / d.page)); S.page = Math.min(S.page, last); const from = (S.page - 1) * d.page;
    box.querySelector('.ui-table-b').innerHTML = tableHead(d.head, cols) + (l.slice(from, from + d.page).map(r => tableRow(r, cols)).join('') || `<p class="ui-empty">${esc(w.noMatch)}</p>`);
    const range = w.range.replace('{from}', from + 1).replace('{to}', Math.min(from + d.page, l.length)).replace('{total}', l.length);
    box.querySelector('.ui-pager').innerHTML = l.length > d.page ? `<button type="button" data-p="-1"${S.page === 1 ? ' disabled' : ''}>‹ ${esc(w.prev)}</button><span>${esc(range)}</span><button type="button" data-p="1"${S.page === last ? ' disabled' : ''}>${esc(w.next)} ›</button>` : '';
  };
  box.addEventListener('click', e => {
    const f = e.target.closest('[data-f]'), p = e.target.closest('[data-p]');
    if (f) { S.f = f.dataset.f; S.page = 1; box.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-pressed', String(x === f))); draw(); }
    if (p && !p.disabled) { S.page += Number(p.dataset.p); draw(); }
  });
  box.querySelector('[data-q]')?.addEventListener('input', e => { S.q = e.target.value.toLowerCase().trim(); S.page = 1; draw(); });
  draw();
}

function formBlock(f) {
  if (f.dataset.wired) return; f.dataset.wired = '1';
  const say = k => f.dataset[k] || WORDS[k];
  f.addEventListener('submit', e => {
    e.preventDefault(); const m = f.querySelector('.ui-form-msg'), b = f.querySelector('button[type=submit],.ui-form-row button'); b.disabled = true; m.textContent = say('sending');
    const data = Object.fromEntries(new FormData(f));
    fetch(f.dataset.uiForm, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok && j.ok !== false, ...j })))
      .then(j => { if (j.ok) f.innerHTML = `<p>${esc(j.message || say('sent'))}</p>`; else { b.disabled = false; m.textContent = j.error || say('failed'); } })
      .catch(() => { b.disabled = false; m.textContent = say('failed'); });
  });
}

/* a calc with inputs: every change works the lines and the total out again */
function calc(box) {
  if (box.dataset.wired) return; box.dataset.wired = '1';
  const d = JSON.parse(box.querySelector('script').textContent);
  const rows = [...box.querySelectorAll(':scope > .ui-calc-r span:last-child')];
  const draw = () => {
    const vals = {};
    for (const el of box.querySelectorAll('[name]')) vals[el.name] = Number(el.value) || 0;
    for (const el of box.querySelectorAll('input[type=range]')) { const f = d.inputs.find(x => x.name === el.name); const o = el.parentNode.querySelector('output'); if (o) o.textContent = formatNumber(Number(el.value), f?.format, d); }
    const v = calcValues(d, vals), out = [...v.lines, ...(d.total ? [v.total] : [])], fmts = [...(d.lines || []).map(l => l.format ?? d.format), ...(d.total ? [d.total.format ?? d.format] : [])];
    rows.forEach((r, k) => { const s = formatNumber(out[k], fmts[k], d); if (r.textContent !== s) { r.textContent = s; r.animate?.([{ opacity: .35 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' }); } });
  };
  box.addEventListener('input', draw);
  box.addEventListener('change', draw);
}
