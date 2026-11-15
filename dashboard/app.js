// Launch Radar page: renders the board, the comps check and the research
// note from window.LAUNCH_RADAR (../data.js, written by the entry's program
// from the same board). No fetch, no network: everything is already here.
//
// Views are also addressable by query string so the page can be captured in
// each of its states: ?view=comps, ?open=<slug>, ?verdict=farm.

const D = window.LAUNCH_RADAR;
const M = D.method;
const rows = D.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Compact dollars, matching the program's own spelling. */
function usd(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const ageWord = (d) => (d === null ? '—' : d >= 365 ? `${(d / 365).toFixed(1)}y` : `${d}d`);

/* The band scale is one log axis for the whole board, so bars compare. */
const logMin = Math.log(Math.min(...rows.map((r) => r.value_low_usd)));
const logMax = Math.log(Math.max(...rows.map((r) => r.value_high_usd)));
const pos = (v) => `${(((Math.log(Math.max(1, v)) - logMin) / (logMax - logMin)) * 100).toFixed(2)}%`;

function bandHtml(r) {
  const left = pos(r.value_low_usd);
  const width = `${(((Math.log(r.value_high_usd) - Math.log(r.value_low_usd)) / (logMax - logMin)) * 100).toFixed(2)}%`;
  return `<div class="band"><span class="band-val">${usd(r.implied_value_usd)}</span>` +
    `<div class="band-track"><div class="band-span" style="left:${left};width:${width}"></div>` +
    `<div class="band-dot" style="left:${pos(r.implied_value_usd)}"></div></div>` +
    `<div class="band-range">${usd(r.value_low_usd)} – ${usd(r.value_high_usd)}</div></div>`;
}

/* ------------------------------------------------ masthead and stats */

$('meta-source').textContent = `Snapshot: DefiLlama, as of ${D.as_of}`;
$('meta-model').textContent = `Model: comps regression on ${M.comps_size} token-bearing protocols, ${M.folds}-fold validated`;
const farmCount = rows.filter((r) => r.verdict === 'farm').length;
const stats = [
  [String(M.snapshot_size), 'protocols in the snapshot'],
  [String(M.universe_size), 'record no token, boarded'],
  [`${M.watchlist_size} / ${M.watchlist_size}`, 'watchlist slugs covered'],
  [String(M.comps_size), 'comps behind every value'],
  [String(farmCount), 'rows verdict: farm'],
];
$('stat-strip').innerHTML = stats.map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
$('band-note').textContent = `Bands are ±1 out-of-sample error (×${M.band_factor}) around each value.`;

/* ------------------------------------------------ filters */

const catSel = $('f-category');
[...new Set(rows.map((r) => r.category ?? 'Uncategorised'))].sort().forEach((c) => {
  const o = document.createElement('option');
  o.value = c; o.textContent = c; catSel.appendChild(o);
});
const chainSel = $('f-chain');
[...new Set(rows.map((r) => r.chains[0] ?? '—'))].sort().forEach((c) => {
  const o = document.createElement('option');
  o.value = c; o.textContent = c; chainSel.appendChild(o);
});

const state = { q: '', category: '', verdict: '', chain: '', sort: 'value', watch: false, view: 'board' };

function visibleRows() {
  let out = rows.filter((r) =>
    (state.category === '' || (r.category ?? 'Uncategorised') === state.category) &&
    (state.verdict === '' || r.verdict === state.verdict) &&
    (state.chain === '' || (r.chains[0] ?? '—') === state.chain) &&
    (!state.watch || r.on_watchlist) &&
    (state.q === '' || r.name.toLowerCase().includes(state.q) || r.slug.includes(state.q)));
  const key = {
    value: (r) => -r.implied_value_usd,
    tvl: (r) => -r.tvl_usd,
    net: (r) => -r.net_ev_usd,
    growth: (r) => -(r.change_7d ?? -Infinity),
    age: (r) => -(r.age_days ?? -1),
  }[state.sort];
  out = [...out].sort((a, b) => key(a) - key(b) || a.rank - b.rank);
  return out;
}

function renderBoard() {
  const vis = visibleRows();
  $('result-count').textContent = `Showing ${vis.length} of ${rows.length} pre-token protocols`;
  $('board-body').innerHTML = vis.map((r) => `<tr data-slug="${esc(r.slug)}">
    <td class="num">${r.rank}</td>
    <td><span class="pname">${r.on_watchlist ? '<span class="wl-dot" title="On the house watchlist"></span>' : ''}${esc(r.name)}</span><span class="pslug">${esc(r.slug)}</span></td>
    <td class="pcat">${esc(r.category ?? 'Uncategorised')}</td>
    <td class="num">${usd(r.tvl_usd)}</td>
    <td class="num ${r.change_7d === null ? 'flat' : r.change_7d >= 0 ? 'pos' : 'neg'}">${pct(r.change_7d)}</td>
    <td class="num">${ageWord(r.age_days)}</td>
    <td>${bandHtml(r)}</td>
    <td class="num">${money(r.season_cost_usd)}</td>
    <td class="num ${r.net_ev_usd >= 0 ? 'pos' : 'neg'}">${r.net_ev_usd >= 0 ? '+' : '−'}${money(Math.abs(r.net_ev_usd)).slice(0)}</td>
    <td><span class="chip ${r.verdict}">${r.verdict.toUpperCase()}</span></td>
  </tr>`).join('');
  for (const tr of $('board-body').querySelectorAll('tr')) {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
  }
}

/* ------------------------------------------------ detail drawer */

function openDetail(slug) {
  const r = bySlug.get(slug);
  if (!r) return;
  const basis = r.category_comps >= 4
    ? `Priced with the ${esc(r.category ?? 'pooled')} category offset of ${r.category_offset >= 0 ? '+' : ''}${r.category_offset} in log terms, fitted on ${r.category_comps} comps in its category.`
    : `Its category holds only ${r.category_comps} comp${r.category_comps === 1 ? '' : 's'}, too few for an offset of its own, so it is priced on the pooled fit.`;
  const flag = r.on_watchlist
    ? 'On the house watchlist: above the $50M floor, records no token, and not a wrapped or staked product.'
    : r.tvl_usd >= D.floor_usd
      ? 'Above the $50M floor but not on the house watchlist: the house record carries a parent-protocol field this snapshot does not show, so read this row with extra care.'
      : 'Below the house floor: an early row the watchlist does not name, which is what a radar is for.';
  $('drawer-in').innerHTML = `
    <button type="button" class="close" id="d-close">Close</button>
    <h2>${esc(r.name)}</h2>
    <div class="d-sub">${esc(r.category ?? 'Uncategorised')} · ${r.chains.map(esc).join(', ') || 'no chains listed'} · rank #${r.rank} of ${rows.length}</div>
    <div class="d-value">${usd(r.implied_value_usd)}<small>implied launch value, the model's point estimate</small></div>
    <div class="d-band"><div class="band-track"><div class="band-span" style="left:${pos(r.value_low_usd)};width:${(((Math.log(r.value_high_usd) - Math.log(r.value_low_usd)) / (logMax - logMin)) * 100).toFixed(2)}%"></div><div class="band-dot" style="left:${pos(r.implied_value_usd)}"></div></div>
    <div class="band-range">band ${usd(r.value_low_usd)} – ${usd(r.value_high_usd)} (±1 out-of-sample error)</div></div>
    <div class="kv">
      <div><b>${usd(r.tvl_usd)}</b><span>TVL</span></div>
      <div><b>${pct(r.change_7d)}</b><span>TVL, 7 days</span></div>
      <div><b>${r.listed_at ?? 'unreported'}</b><span>tracked since</span></div>
      <div><b>${ageWord(r.age_days)}</b><span>with no token recorded</span></div>
      <div><b>${r.multiple_of_tvl}×</b><span>implied value / TVL</span></div>
      <div><b>${money(r.capital_usd)}</b><span>season capital</span></div>
    </div>
    <h3>Why this value</h3>
    <p>${basis} The fit prices a protocol from its TVL and its seven-day TVL growth across ${M.comps_size} token-bearing comps; the band is that fit's measured out-of-sample error, not a confidence flourish.</p>
    <h3>The season's economics</h3>
    <div class="kv">
      <div><b>${money(r.gas_usd)}</b><span>gas, ${r.chains[0] ?? 'main chain'}</span></div>
      <div><b>${money(r.time_usd)}</b><span>time, 4 hours</span></div>
      <div><b>${money(r.opportunity_usd)}</b><span>capital opportunity</span></div>
      <div><b>${money(r.season_cost_usd)}</b><span>season cost, total</span></div>
      <div><b>${r.crowd.toLocaleString('en-US')}</b><span>farmers assumed</span></div>
      <div><b>${money(r.gross_ev_usd)}</b><span>expected share, low end</span></div>
    </div>
    <div class="verdict-box ${r.verdict}"><span class="chip ${r.verdict}">${r.verdict.toUpperCase()}</span><p style="margin:8px 0 0">${esc(r.verdict_reason)}</p></div>
    <h3>How to farm it</h3>
    <ol class="steps">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <p class="caveat">${flag} ${esc(r.name)} records no token in the snapshot's DefiLlama record as of ${D.as_of}; a record is not proof, and this board does not predict whether or when a token is issued.</p>`;
  $('drawer').hidden = false;
  $('scrim').hidden = false;
  $('d-close').addEventListener('click', closeDetail);
}
function closeDetail() { $('drawer').hidden = true; $('scrim').hidden = true; }
$('scrim').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

/* ------------------------------------------------ comps view */

function renderComps() {
  $('comps-intro').textContent =
    `The value model is fitted on these ${M.comps_size} protocols: they already trade, so the market states their value outright. ` +
    `Each row sets that value beside what the model would have fitted from TVL, growth and category alone. ` +
    `Out of sample (five folds, each fitted without the fold it predicts), the fit's log error is ${M.oos_rmsle}: ` +
    `${M.oos_within_band_pct}% of held-out comps landed inside the ±1-error band the board draws, and ${M.oos_within_2x_pct}% within a factor of two.`;
  const ratios = D.comps.map((c) => Math.log(c.ratio));
  const lo = Math.min(...ratios), hi = Math.max(...ratios);
  $('comps-body').innerHTML = D.comps.map((c) => {
    const left = ((Math.min(0, Math.log(c.ratio)) - lo) / (hi - lo)) * 100;
    const width = Math.max(1.5, ((Math.abs(Math.log(c.ratio))) / (hi - lo)) * 100);
    return `<tr data-slug="${esc(c.slug)}">
      <td><span class="pname">${esc(c.name)}</span><span class="pslug">${esc(c.slug)}</span></td>
      <td class="pcat">${esc(c.category ?? 'Uncategorised')}</td>
      <td class="num">${usd(c.tvl_usd)}</td>
      <td class="num">${usd(c.mcap_usd)}</td>
      <td class="num">${usd(c.fitted_usd)}</td>
      <td><div class="ratio-track"><div class="ratio-fill" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></div><div class="ratio-one" style="left:${((-lo / (hi - lo)) * 100).toFixed(1)}%"></div></div><div class="band-range">${c.ratio}×</div></td>
    </tr>`;
  }).join('');
}

/* ------------------------------------------------ research note */

function renderMethod() {
  $('method-body').innerHTML = `
    <h2>Research note: how this radar prices a launch that has not happened</h2>
    <p><strong>The question.</strong> Of the ${M.snapshot_size} protocols in the snapshot, which ones still record no token, what would a token be worth if the record stayed as it is, and which of them are worth a farmer's season? Everything below is computed from the snapshot alone; no protocol name is special-cased anywhere in the program.</p>
    <h3>1. The universe</h3>
    <p>A protocol joins the board when it records no token (both its CoinGecko id and its symbol are null) and is not a wrapped, staked or bridged product of a token that trades. The product screen is the house's own, applied at every TVL rather than only above its $50M floor: the categories Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC and CEX are out, as are versioned names, names carrying the whole word wrapped, staked or staking, and names beginning with an exchange's name. That leaves <strong>${M.universe_size} protocols</strong>, including all ${M.watchlist_size} watchlist slugs. One limit is stated plainly: DefiLlama also screens on a parent-protocol field the snapshot does not carry, so a handful of rows above the floor that the house left out may be products of traded tokens; each such row's detail view flags it.</p>
    <h3>2. The value model</h3>
    <p>The comparables are the snapshot's own token-bearing protocols: ${M.comps_size} of them carry a market cap and are not pass-through products themselves. On those, the program fits one regression:</p>
    <div class="eq">ln(market cap) = ${M.intercept} + ${M.slope_tvl} · ln(TVL) + (${M.slope_growth}) · clamp(7d growth, −30%, +60%) + category offset</div>
    <p>A category's offset is its comps' mean residual, kept only when the category holds at least four comps and shrunk toward zero by n/(n+3), so thin categories borrow the pooled fit instead of inventing a multiple. The slope under 1 is the data's own verdict: across DeFi, market value grows much more slowly than TVL, and the largest pools are worth the least per dollar locked. The growth term is negative for the same reason — a fast-growing TVL is often rented, and the comps price it that way. Age was fitted as a fourth term and dropped: it did not lower the out-of-sample error, so age is printed on every row but never priced.</p>
    <h3>3. Validation, out of sample</h3>
    <table class="mini">
      <tr><th>Measure</th><th>Value</th></tr>
      <tr><td>Comps fitted</td><td class="n">${M.comps_size}</td></tr>
      <tr><td>Folds (each fitted without the fold it predicts)</td><td class="n">${M.folds}</td></tr>
      <tr><td>Out-of-sample log error (RMS)</td><td class="n">${M.oos_rmsle}</td></tr>
      <tr><td>Median absolute log error, held out</td><td class="n">${M.oos_median_abs_log}</td></tr>
      <tr><td>Held-out comps inside the ±1-error band</td><td class="n">${M.oos_within_band_pct}%</td></tr>
      <tr><td>Held-out comps within a factor of two</td><td class="n">${M.oos_within_2x_pct}%</td></tr>
      <tr><td>In-sample log error, for contrast</td><td class="n">${M.in_sample_rmsle}</td></tr>
    </table>
    <p>The honest reading: token values are only loosely tied to TVL, and any radar that hides that is lying with decimals. The board therefore ranks on the fitted value but judges on the band: every row's band is its value widened by ×${M.band_factor} either way — exactly this out-of-sample error — and the verdict below is priced at the band's low end.</p>
    <h3>4. The farm economics</h3>
    <p>Each row prices one ${M.season_days}-day season: sixteen on-chain actions on the protocol's first chain (Ethereum gas at $16 an action, Solana at $0.10, BNB Chain at $0.35, major L2s at $0.60), four hours of a farmer's time at $12, and the locked capital's opportunity cost at 5% a year. The capital a position needs rises with the protocol's size, from $100 to $1,000. Against that cost: if the protocol launched at the low end of its band and ${M.pool_share * 100}% of the launch value reached early users collectively — the middle of the usual community allocation, taken at the band's low end so the two conservatisms offset — one farmer's expected share is that pool divided by an assumed crowd of one consistent farmer per $250,000 of TVL (floored at 400, capped at 30,000). <strong>Farm</strong>: the low-end share covers the cost at least three times. <strong>Thin</strong>: it covers the cost, but by less. <strong>Skip</strong>: it does not cover the cost.</p>
    <h3>5. Caveats</h3>
    <ul>
      <li>Every protocol here <em>records no token</em> in the snapshot's record. Say that, never that it has none: a record can lag a launch, and the snapshot is frozen at ${D.as_of}.</li>
      <li>An implied value is this board's claim about a launch that may never happen, priced as if the record stayed as it is. It is not a prediction, and it is not make.fun's claim.</li>
      <li>The snapshot carries no points program, no airdrop flag and no allocation promise. The farm economics are stated assumptions, printed above so a reader can disagree with them in numbers, not in vibes.</li>
    </ul>`;
}

/* ------------------------------------------------ views and wiring */

function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('is-on', b.dataset.view === v);
  $('view-board').hidden = v !== 'board';
  $('view-comps').hidden = v !== 'comps';
  $('view-method').hidden = v !== 'method';
  document.querySelector('.toolbar .ctl.grow').style.visibility = v === 'board' ? 'visible' : 'hidden';
}
for (const b of document.querySelectorAll('.seg-btn')) b.addEventListener('click', () => setView(b.dataset.view));
$('f-search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderBoard(); });
catSel.addEventListener('change', (e) => { state.category = e.target.value; renderBoard(); });
$('f-verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
chainSel.addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
$('f-sort').addEventListener('change', (e) => { state.sort = e.target.value; renderBoard(); });
$('f-watch').addEventListener('change', (e) => { state.watch = e.target.checked; renderBoard(); });

/* Query-string state, so each view can be captured as it is used. */
const params = new URLSearchParams(location.search);
if (params.get('verdict')) { state.verdict = params.get('verdict'); $('f-verdict').value = state.verdict; }
if (params.get('cat')) { state.category = params.get('cat'); catSel.value = state.category; }
if (params.get('watch') === '1') { state.watch = true; $('f-watch').checked = true; }
if (params.get('sort')) { state.sort = params.get('sort'); $('f-sort').value = state.sort; }

renderBoard();
renderComps();
renderMethod();
if (params.get('view')) setView(params.get('view'));
if (params.get('open')) openDetail(params.get('open'));
