// Isometric "test rig": a small machine whose parts mirror the real flow.
// Panel = the page under test, probe = the Playwright run, dial = runs passed, lamps = checks in the plan.
(function () {
  const K = 26, OX = 250, OY = 150;
  const P = (x, y, z) => [OX + (x - y) * K, OY + (x + y) * K / 2 - z * K];
  const pts = (a) => a.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
  function box(x0, y0, z0, w, d, h, cls, extra) {
    const x1 = x0 + w, y1 = y0 + d, z1 = z0 + h;
    return `<g class="${cls}"${extra || ''}>` +
      `<polygon class="f-l" points="${pts([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)])}"/>` +
      `<polygon class="f-r" points="${pts([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)])}"/>` +
      `<polygon class="f-t" points="${pts([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)])}"/></g>`;
  }
  const faceY = (y) => { const o = P(0, y, 0); return `matrix(${K} ${K / 2} 0 ${-K} ${o[0]} ${o[1]})`; };
  const n = 3; // lamps; lit count follows the plan
  let svg = `<svg viewBox="70 20 460 360" role="img" aria-label="Isometric test rig: a probe presses the page under test and a dial shows runs passed">`;
  svg += `<ellipse class="shadow" cx="300" cy="300" rx="220" ry="48"/>`;
  svg += box(0, 0, 0, 10, 6, .6, 'base');
  // feet
  [[.4, .4], [9.2, .4], [.4, 5.2], [9.2, 5.2]].forEach(([a, b]) => { svg += box(a, b, -.25, .4, .4, .25, 'foot'); });
  // rails with ticks
  svg += box(1.2, 3.6, .6, 6.2, .22, .12, 'rail');
  for (let i = 0; i <= 12; i++) svg += `<line class="tick" x1="${P(1.3 + i * .5, 3.82, .72)[0]}" y1="${P(1.3 + i * .5, 3.82, .72)[1]}" x2="${P(1.3 + i * .5, 3.82, .72)[0]}" y2="${P(1.3 + i * .5, 3.82, .72)[1] - (i % 2 ? 3 : 5)}"/>`;
  // page panel
  svg += box(1.2, .6, .6, 6.2, .3, 4.6, 'panel');
  svg += `<g transform="${faceY(.9)}" class="screen">`;
  svg += `<rect x="1.45" y="3.7" width="5.7" height="1.2" rx=".08" class="bar-top"/><circle cx="1.7" cy="4.3" r=".12" class="d1"/><circle cx="2.05" cy="4.3" r=".12" class="d2"/><circle cx="2.4" cy="4.3" r=".12" class="d3"/>`;
  svg += `<rect x="1.8" y="2.9" width="4.9" height=".38" rx=".06" class="field"/><rect x="1.8" y="2.2" width="4.9" height=".38" rx=".06" class="field"/>`;
  svg += `<rect id="rig-btn" x="3.5" y="1.2" width="1.6" height=".55" rx=".12" class="btn"/>`;
  svg += `<rect id="rig-ok" x="1.8" y="1.2" width="1.4" height=".55" rx=".12" class="ok"/>`;
  svg += `</g>`;
  // probe on rail (screen position of the button face)
  svg += `<g id="rig-probe">` + box(3.9, .95, 1.15, .8, 2.4, .5, 'probe') + box(4.1, 3.3, 1.2, .4, .5, .4, 'carriage') + `</g>`;
  // gauge post with dial
  svg += box(8.0, 3.0, .6, 1.8, .6, 3.2, 'post');
  svg += `<g transform="${faceY(3.6)}"><circle cx="8.9" cy="2.45" r=".78" class="dial-rim"/><circle cx="8.9" cy="2.45" r=".64" class="dial-face"/>`;
  for (let i = 0; i <= 8; i++) { const a = (-60 + i * 15) * Math.PI / 180; const c = [8.9, 2.45];
    svg += `<line class="dial-tick" x1="${c[0] + Math.sin(a) * .5}" y1="${c[1] + Math.cos(a) * .5}" x2="${c[0] + Math.sin(a) * .6}" y2="${c[1] + Math.cos(a) * .6}"/>`; }
  svg += `<g id="rig-needle" style="transform-origin:8.9px 2.45px;transform-box:view-box"><line x1="8.9" y1="2.45" x2="8.9" y2="3.02" class="needle"/></g><circle cx="8.9" cy="2.45" r=".07" class="hub"/></g>`;
  // lamps = checks
  for (let i = 0; i < n; i++) svg += box(1.6 + i * .9, 4.9, .6, .5, .5, .18, 'lamp', ` id="lamp${i}"`);
  svg += `</svg>`;
  const host = document.getElementById('rig');
  if (!host) return;
  host.innerHTML = svg;
  const probe = host.querySelector('#rig-probe'), needle = host.querySelector('#rig-needle');
  const dy = (u) => `translate(${(-K * u).toFixed(1)}px, ${(K * u / 2).toFixed(1)}px)`;
  probe.style.transform = dy(2.3);
  needle.style.transform = 'rotate(-60deg)';
  let loop = null;
  function press(go) { probe.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1)'; probe.style.transform = dy(go ? 0 : 2.3); }
  window.rig = {
    // state: idle | planned(count) | running | done(passed, total)
    planned(count) { host.dataset.state = 'planned'; for (let i = 0; i < n; i++) host.querySelector('#lamp' + i).classList.toggle('on', i < Math.min(count, n)); },
    running() { host.dataset.state = 'running'; clearInterval(loop); let d = 0; press(true); loop = setInterval(() => { d ^= 1; press(!d); }, 650); },
    done(passed, total) {
      clearInterval(loop); press(false); host.dataset.state = passed === total ? 'pass' : 'fail';
      needle.style.transition = 'transform 1.2s cubic-bezier(.3,1.4,.4,1)';
      needle.style.transform = `rotate(${-60 + 120 * (passed / Math.max(total, 1))}deg)`;
    }
  };
})();
