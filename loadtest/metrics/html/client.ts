// The one inline script of the report (S54, heavy-load design §4.1). It only
// adds table sorting, a linear/log toggle for the latency axes and opens every
// `<details>` before printing. It reads no data and builds DOM with
// `textContent` / `createElement` only. The page is complete without it.
export const REPORT_CLIENT_JS = `(function () {
  'use strict';
  function cellValue(row, index) {
    var cell = row.children[index];
    if (!cell) return '';
    var v = cell.getAttribute('data-v');
    if (v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
    return (cell.textContent || '').trim().toLowerCase();
  }
  function sortTable(table, index, th) {
    var body = table.tBodies[0];
    if (!body) return;
    var asc = !th.classList.contains('sorted') || !th.classList.contains('asc');
    var rows = Array.prototype.slice.call(body.rows).filter(function (r) { return !r.classList.contains('total'); });
    var totals = Array.prototype.slice.call(body.rows).filter(function (r) { return r.classList.contains('total'); });
    rows.sort(function (a, b) {
      var x = cellValue(a, index), y = cellValue(b, index);
      var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
      return asc ? c : -c;
    });
    rows.concat(totals).forEach(function (r) { body.appendChild(r); });
    Array.prototype.forEach.call(table.tHead.rows[0].cells, function (h) { h.classList.remove('sorted', 'asc'); });
    th.classList.add('sorted');
    if (asc) th.classList.add('asc');
  }
  Array.prototype.forEach.call(document.querySelectorAll('table.sortable'), function (table) {
    if (!table.tHead || !table.tHead.rows[0]) return;
    Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th, index) {
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      th.addEventListener('click', function () { sortTable(table, index, th); });
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortTable(table, index, th); } });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.axis-toggle'), function (box) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'axisbtn';
    button.setAttribute('aria-pressed', 'false');
    button.textContent = 'Log axis';
    button.addEventListener('click', function () {
      var on = box.classList.toggle('is-log');
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    box.insertBefore(button, box.firstChild);
  });
  window.addEventListener('beforeprint', function () {
    Array.prototype.forEach.call(document.querySelectorAll('details'), function (d) { d.open = true; });
  });
})();`;
