/* Shared chart zoom: left-click and drag across a chart to zoom into that range, right-click to reset.
   The selection box is a DOM overlay, so a chart only has to say how to map pixels to its own x-axis.
   LegionZoom.attach(canvas, {
     plot: () => ({ l, r }),        // plot area in CSS px from the canvas's left edge
     onZoom: (x1, x2) => {},        // selected pixel range, x1 < x2
     onReset: () => {},             // right-click
     shift: false,                  // true: only Shift + drag zooms (plain drag stays the chart's own pan)
   }) */
(function () {
  'use strict';
  const MIN_PX = 6;

  function attach(canvas, o) {
    if (!canvas || canvas._legionZoom) return;
    canvas._legionZoom = true;
    const host = canvas.parentElement;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const box = document.createElement('div');
    box.className = 'lz-box';
    host.appendChild(box);
    let drag = null, swallowClick = false;

    const local = e => e.clientX - canvas.getBoundingClientRect().left;
    const clamp = x => { const p = o.plot(); return Math.max(p.l, Math.min(p.r, x)); };

    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0 || (o.shift && !e.shiftKey)) return;
      const p = o.plot(), x = local(e);
      if (x < p.l || x > p.r) return;
      drag = { x1: x, x2: x };
      if (o.shift) { e.preventDefault(); e.stopImmediatePropagation(); } // keep the chart's own pan from starting
    }, true);
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      drag.x2 = clamp(local(e));
      const a = Math.min(drag.x1, drag.x2), b = Math.max(drag.x1, drag.x2);
      if (b - a < MIN_PX) { box.style.display = 'none'; return; }
      const top = canvas.offsetTop, left = canvas.offsetLeft;
      Object.assign(box.style, { display: 'block', left: left + a + 'px', width: b - a + 'px', top: top + 'px', height: canvas.offsetHeight + 'px' });
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const a = Math.min(drag.x1, drag.x2), b = Math.max(drag.x1, drag.x2);
      drag = null; box.style.display = 'none';
      if (b - a >= MIN_PX) { swallowClick = true; setTimeout(() => (swallowClick = false), 0); o.onZoom(a, b); }
    });
    // a drag that zoomed must not also count as a click (e.g. "click opens full screen")
    canvas.addEventListener('click', e => { if (swallowClick) { e.stopImmediatePropagation(); e.preventDefault(); swallowClick = false; } }, true);
    canvas.addEventListener('contextmenu', e => { e.preventDefault(); drag = null; box.style.display = 'none'; o.onReset(); });
  }

  window.LegionZoom = { attach };
})();
