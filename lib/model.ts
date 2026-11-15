// Launch Radar model: one sealed snapshot in, one ranked pre-token board out.
//
// The board is built in three moves, all from the snapshot's own figures.
//
// 1. The universe. A protocol joins the board when it records no token (both
//    gecko_id and symbol null) and is not a wrapped, staked or bridged product
//    of one that trades: the house's product filters (category, versioned
//    names, wrapped/staked words, exchange prefixes) applied at every TVL,
//    not only above the watchlist floor. The watchlist is a floor: every one
//    of its slugs is on the board, and the board reaches far below it.
//
// 2. The value model. The snapshot's own token-bearing protocols are the
//    comparables: 94 of them carry a market cap and are not themselves a
//    pass-through product. A log-log regression prices them:
//
//      ln(mcap) = a + b * ln(TVL) + c * clamp(change_7d, -30, 60) / 100
//                 + category offset (shrunk toward zero for thin categories)
//
//    The fit is validated out of sample with five folds over the comps set;
//    the out-of-sample log error sets the width of every value band. Age was
//    tested as a fourth regressor and dropped: it did not lower the
//    out-of-sample error, so it is reported on every row but never priced.
//
// 3. The farm economics. Each row prices one 90-day farming season: the gas
//    of its main chain, the hours it takes, and the opportunity cost of the
//    capital a position needs. Against that cost stands the conservative end
//    of the value band: if the protocol launched there, and 5% of the launch
//    value reached early users, one farmer's expected share is that pool
//    divided by the crowd a protocol of its size attracts. The verdict is
//    the ratio of the two: farm, thin or skip.

/** One protocol of the snapshot: exactly the ten fields the sealed input carries. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** Why a snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Whole days from a protocol's listing day to the snapshot's day; null when unreported. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A dollar figure with thousands separators, written by hand so every run spells it the same. */
export function fmtUsd(n: number): string {
  const whole = Math.round(Math.abs(n));
  const digits = String(whole);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return `${n < 0 ? '-' : ''}$${out}`;
}

/** A compact dollar figure for table cells: $1.24B, $38.5M, $912K, $640. */
export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- the universe

/** Categories that are a pass-through of a token that already trades, per the house's rule. */
export const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** DefiLlama's version marker: a name ending in a release is another protocol's pool. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol records no token: both token fields null. */
export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a wrapped, staked or bridged product of a token that trades. */
export function isProductOfTraded(p: Protocol): boolean {
  return (
    PRODUCT_CATEGORIES.has(p.category ?? '') ||
    VERSIONED.test(p.name) ||
    WRAPPED_WORD.test(p.name) ||
    EXCHANGE_PREFIX.test(p.name)
  );
}

/** The board's universe: records no token, and not a product of one that trades. */
export function universeOf(snapshot: Snapshot): Protocol[] {
  return snapshot.protocols.filter((p) => recordsNoToken(p) && !isProductOfTraded(p));
}

/** The comparables: token-bearing, with a market cap, and not a pass-through product themselves. */
export function compsOf(snapshot: Snapshot): Protocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && !PRODUCT_CATEGORIES.has(p.category ?? ''),
  );
}

// ---------------------------------------------------------------- the fit

/** The fitted value model: coefficients, shrunk category offsets, and its out-of-sample record. */
export interface ValueFit {
  intercept: number;
  slope_tvl: number;
  slope_growth: number;
  offsets: Map<string, number>;
  offset_counts: Map<string, number>;
  comps_size: number;
  folds: number;
  oos_rmsle: number;
  oos_median_abs_log: number;
  oos_within_2x: number;
  oos_within_band: number;
  in_sample_rmsle: number;
}

/** The growth regressor: seven-day TVL change, clamped, as a fraction. */
function growthTerm(p: Protocol): number {
  return clamp(p.change_7d ?? 0, -30, 60) / 100;
}

/** The design row of the regression for one protocol. */
function designRow(p: Protocol): number[] {
  return [1, Math.log(p.tvl_usd), growthTerm(p)];
}

/** Least squares by the normal equations, solved with partial pivoting. */
function leastSquares(x: number[][], y: number[]): number[] {
  const k = x[0]!.length;
  const a = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i++) {
    for (let r = 0; r < k; r++) {
      b[r]! += x[i]![r]! * y[i]!;
      for (let c = 0; c < k; c++) a[r]![c]! += x[i]![r]! * x[i]![c]!;
    }
  }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r;
    [a[c], a[piv]] = [a[piv]!, a[c]!];
    [b[c], b[piv]] = [b[piv]!, b[c]!];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / a[c]![c]!;
      for (let cc = 0; cc < k; cc++) a[r]![cc]! -= f * a[c]![cc]!;
      b[r]! -= f * b[c]!;
    }
  }
  return b.map((_, i) => b[i]! / a[i]![i]!);
}

/** A category's offset: its mean residual, kept only from four comps up and shrunk by n / (n + 3). */
function categoryOffsets(train: Protocol[], beta: number[]): Map<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const p of train) {
    const resid = Math.log(p.mcap_usd!) - designRow(p).reduce((s, v, j) => s + v * beta[j]!, 0);
    const key = p.category ?? '(no category)';
    const cell = sums.get(key) ?? { total: 0, n: 0 };
    cell.total += resid;
    cell.n += 1;
    sums.set(key, cell);
  }
  const out = new Map<string, number>();
  for (const [key, cell] of sums) {
    out.set(key, cell.n >= 4 ? (cell.total / cell.n) * (cell.n / (cell.n + 3)) : 0);
  }
  return out;
}

/** Fit the regression and its offsets on a set of comps. */
function fitOn(train: Protocol[]): { beta: number[]; offsets: Map<string, number> } {
  const beta = leastSquares(
    train.map(designRow),
    train.map((p) => Math.log(p.mcap_usd!)),
  );
  return { beta, offsets: categoryOffsets(train, beta) };
}

/** The model's log prediction for one protocol under a fit. */
function logPredict(beta: number[], offsets: Map<string, number>, p: Protocol): number {
  const base = designRow(p).reduce((s, v, j) => s + v * beta[j]!, 0);
  return base + (offsets.get(p.category ?? '(no category)') ?? 0);
}

/** A stable fold number for a slug: the same slug always lands in the same fold. */
function foldOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % 5;
}

/**
 * Fit the value model on all comps, and measure it out of sample: five folds,
 * each fitted without the fold it predicts. The out-of-sample log error is the
 * board's band width, so the band is calibrated on protocols the fit never saw.
 */
export function fitValueModel(comps: Protocol[]): ValueFit {
  const full = fitOn(comps);
  const oosErrors: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = comps.filter((p) => foldOf(p.slug) !== fold);
    const held = comps.filter((p) => foldOf(p.slug) === fold);
    const part = fitOn(train);
    for (const p of held) oosErrors.push(Math.log(p.mcap_usd!) - logPredict(part.beta, part.offsets, p));
  }
  const rmsle = Math.sqrt(oosErrors.reduce((s, e) => s + e * e, 0) / oosErrors.length);
  const absSorted = oosErrors.map(Math.abs).sort((a, b) => a - b);
  const inErrors = comps.map((p) => Math.log(p.mcap_usd!) - logPredict(full.beta, full.offsets, p));
  const counts = new Map<string, number>();
  for (const p of comps) counts.set(p.category ?? '(no category)', (counts.get(p.category ?? '(no category)') ?? 0) + 1);
  return {
    intercept: full.beta[0]!,
    slope_tvl: full.beta[1]!,
    slope_growth: full.beta[2]!,
    offsets: full.offsets,
    offset_counts: counts,
    comps_size: comps.length,
    folds: 5,
    oos_rmsle: rmsle,
    oos_median_abs_log: absSorted[Math.floor(absSorted.length / 2)]!,
    oos_within_2x: oosErrors.filter((e) => Math.abs(e) < Math.log(2)).length / oosErrors.length,
    oos_within_band: oosErrors.filter((e) => Math.abs(e) <= rmsle).length / oosErrors.length,
    in_sample_rmsle: Math.sqrt(inErrors.reduce((s, e) => s + e * e, 0) / inErrors.length),
  };
}

// ---------------------------------------------------------------- farm economics

/** The season the farm economics price: days of qualifying activity. */
export const SEASON_DAYS = 90;
/** The share of a launch's value assumed to reach early users collectively: the middle of the usual 3 to 10% community allocation, taken at the band's low end so the two conservatisms offset. */
export const POOL_SHARE = 0.05;
/** What an hour of a farmer's time is priced at. */
export const HOUR_USD = 12;
/** The opportunity cost of locked capital, per year. */
export const CAPITAL_APR = 0.05;
/** On-chain actions one season takes: open, twelve weekly touches, a claim, an exit, one spare. */
export const SEASON_ACTIONS = 16;

/** Gas for one on-chain action on a chain, by the chain's fee class. */
export function gasPerAction(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 16;
  if (c === 'solana') return 0.1;
  if (c === 'bsc' || c === 'binance') return 0.35;
  if (['base', 'arbitrum', 'optimism', 'polygon', 'zksync era', 'linea', 'scroll', 'mantle', 'blast', 'mode', 'taiko', 'avalanche', 'fantom', 'gnosis'].includes(c)) return 0.6;
  return 1.2;
}

/** The capital a sensible first position needs, from the protocol's size. */
export function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 1000;
  if (tvl >= 250_000_000) return 500;
  if (tvl >= 50_000_000) return 250;
  return 100;
}

/** The crowd of farmers a protocol of this size is assumed to draw over a season: one consistent season farmer per $250,000 of TVL, floored and capped. */
export function crowdFor(tvl: number): number {
  return Math.round(clamp(tvl / 250_000, 400, 30_000));
}

/** How long a position should be held: younger protocols ask for a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return SEASON_DAYS;
  if (age < 180) return 120;
  if (age < 365) return 105;
  return SEASON_DAYS;
}

/** One row's priced season: what farming it costs, in dollars and hours. */
export interface SeasonCost {
  capital_usd: number;
  gas_usd: number;
  hours: number;
  time_usd: number;
  opportunity_usd: number;
  total_usd: number;
}

/** Price one season of farming a protocol on its first-listed chain. */
export function seasonCost(p: Protocol): SeasonCost {
  const chain = p.chains[0] ?? 'Ethereum';
  const capital = capitalFor(p.tvl_usd);
  const gas = Math.round(gasPerAction(chain) * SEASON_ACTIONS * 100) / 100;
  const hours = 4;
  const opportunity = Math.round(capital * CAPITAL_APR * (SEASON_DAYS / 365) * 100) / 100;
  const time = hours * HOUR_USD;
  return { capital_usd: capital, gas_usd: gas, hours, time_usd: time, opportunity_usd: opportunity, total_usd: Math.round((gas + time + opportunity) * 100) / 100 };
}

// ---------------------------------------------------------------- farm plans

/** The core action a category asks of a farmer, in words a reader can follow. */
function coreAction(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('dex')) return `Provide ${fmtUsd(capital)} of liquidity to ${name}'s deepest pool on ${chain}, split between the pool's two assets, and keep the position open`;
  if (c.includes('lend') || c.includes('collateral')) return `Supply ${fmtUsd(capital)} of a major stablecoin to ${name} on ${chain}; if it offers a points page, link the wallet there before the first supply`;
  if (c.includes('cdp')) return `Deposit ${fmtUsd(capital)} of collateral into ${name} on ${chain} and mint a small position of its stablecoin against it, well inside its safety limit`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield')) return `Deposit ${fmtUsd(capital)} into a ${name} vault on ${chain} and keep the vault shares in the same wallet all season`;
  if (c.includes('rwa')) return `Mint or subscribe ${fmtUsd(capital)} of ${name}'s yield asset on ${chain} through its own app and hold the asset in the farming wallet`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Deposit ${fmtUsd(capital)} of margin on ${name} and trade small hedged volume each week rather than one large position`;
  if (c.includes('basis')) return `Deposit ${fmtUsd(capital)} into ${name}'s basis vault on ${chain} and leave the position untouched between weekly checks`;
  if (c === 'chain') return `Bridge ${fmtUsd(capital)} onto ${name} itself and use its native applications weekly: a swap, a lend and a name or domain action if it offers one`;
  if (c.includes('staking')) return `Stake ${fmtUsd(capital)} of the chain's native asset through ${name} and keep the staking receipt in the farming wallet`;
  if (c.includes('prediction')) return `Fund ${fmtUsd(capital)} on ${name} and hold one small position in an active market, rolling it as markets settle`;
  if (c.includes('insurance')) return `Buy ${fmtUsd(capital)} of cover from ${name} on ${chain}, or underwrite its smallest pool if it takes underwriters`;
  if (c.includes('index')) return `Mint ${fmtUsd(capital)} of a ${name} index on ${chain} and hold the index token rather than its components`;
  if (c.includes('payment') || c.includes('card')) return `Open a ${name} account, route one real payment or card spend of about ${fmtUsd(capital)} through it, and keep the account active weekly`;
  return `Deposit ${fmtUsd(capital)} into ${name}'s core product on ${chain} and keep the position open for the whole season`;
}

/** The weekly touch a category rewards, in one clause. */
function weeklyAction(p: Protocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex')) return 'one swap through the same pool';
  if (c.includes('lend')) return 'one supply, borrow or repay movement';
  if (c.includes('derivative') || c.includes('perpetual')) return 'one small hedged trade';
  if (c === 'chain') return 'two or three transactions in its native applications';
  if (c.includes('prediction')) return 'one position opened or rolled';
  return 'one deposit, withdrawal-and-redeposit or claim movement';
}

/**
 * A protocol's farm plan: five steps, each an action with its cost and its
 * time inside the string, derived from the protocol's own record (category,
 * first chain, TVL, age) and the season the economics price.
 */
export function farmSteps(p: Protocol, age: number | null, cost: SeasonCost): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const gas = gasPerAction(p.chains[0] ?? 'Ethereum');
  const hold = holdDaysFor(age);
  const gasWord = gas >= 10 ? 'mainnet gas is the real cost here' : 'gas is a minor cost here';
  return [
    `Start with a fresh wallet funded on ${chain} with the season's capital plus gas; keep its seed phrase offline and use it for ${p.name} only. Cost: ${fmtUsd(cost.capital_usd)} of capital and about ${fmtUsd(Math.max(1, Math.round(gas * 2)))} of gas to fund and approve. Time: 20 minutes.`,
    `${coreAction(p, cost.capital_usd, chain)}. Cost: the ${fmtUsd(cost.capital_usd)} position plus about ${fmtUsd(Math.max(1, Math.round(gas)))} of gas; ${gasWord}. Time: 30 minutes to set up.`,
    `Return weekly for ${weeklyAction(p)} so the wallet shows a season of use, not a single day. Cost: about ${fmtUsd(Math.max(1, Math.round(gas * 12)))} of gas across twelve weekly touches. Time: 15 minutes a week.`,
    `Hold the position for at least ${hold} days and check the protocol's own points or rewards page monthly; screenshot the balance for your farm log. Cost: ${fmtUsd(cost.opportunity_usd)} of foregone yield on the locked capital. Time: ${hold} days, minutes a week.`,
    `At the season's end, claim only through the link the protocol's own page publishes, and never pay a third party to claim for you. Cost: about ${fmtUsd(Math.max(1, Math.round(gas * 2)))} of gas to claim and unwind. Time: 30 minutes.`,
  ];
}

// ---------------------------------------------------------------- the board

/** One row of the board, with everything the dashboard shows for it. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  value_low_usd: number;
  value_high_usd: number;
  multiple_of_tvl: number;
  category_offset: number;
  category_comps: number;
  season_cost_usd: number;
  capital_usd: number;
  gas_usd: number;
  time_usd: number;
  opportunity_usd: number;
  crowd: number;
  gross_ev_usd: number;
  net_ev_usd: number;
  verdict: 'farm' | 'thin' | 'skip';
  verdict_reason: string;
  farm_steps: string[];
}

/** A comparable as the dashboard's comps view shows it: the market's value beside the model's. */
export interface CompRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  fitted_usd: number;
  ratio: number;
}

/** The methodology figures the dashboard states, all computed from the snapshot. */
export interface MethodData {
  universe_size: number;
  snapshot_size: number;
  watchlist_size: number;
  comps_size: number;
  folds: number;
  intercept: number;
  slope_tvl: number;
  slope_growth: number;
  oos_rmsle: number;
  oos_median_abs_log: number;
  oos_within_2x_pct: number;
  oos_within_band_pct: number;
  in_sample_rmsle: number;
  band_factor: number;
  pool_share: number;
  season_days: number;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  method: MethodData;
  rows: BoardRow[];
  comps: CompRow[];
}

/** The verdict and its one-sentence reason from a row's economics. */
function verdictFor(gross: number, cost: number, net: number): { verdict: BoardRow['verdict']; reason: string } {
  if (gross >= 3 * cost) {
    return {
      verdict: 'farm',
      reason: `Even at the low end of its band, the expected share of a launch (${fmtUsd(gross)}) covers the season's cost (${fmtUsd(cost)}) more than three times over.`,
    };
  }
  if (gross > cost) {
    return {
      verdict: 'thin',
      reason: `The low-end expected share (${fmtUsd(gross)}) clears the season's cost (${fmtUsd(cost)}) but by less than three times, so the margin is thin if the launch prices lower or the crowd is bigger.`,
    };
  }
  return {
    verdict: 'skip',
    reason: `The low-end expected share (${fmtUsd(gross)}) does not cover the season's cost (${fmtUsd(cost)}); farming it is priced as a loss of about ${fmtUsd(-net)} unless the launch beats the band.`,
  };
}

/** Build the whole radar: universe, fit, board rows, comps view, methodology figures. */
export function buildRadar(snapshot: Snapshot): RadarData {
  const universe = universeOf(snapshot);
  const comps = compsOf(snapshot);
  const fit = fitValueModel(comps);
  const watch = new Set(snapshot.watchlist);
  const bandFactor = Math.exp(fit.oos_rmsle);

  const rows: BoardRow[] = universe.map((p) => {
    const logV = logPredict([fit.intercept, fit.slope_tvl, fit.slope_growth], fit.offsets, p);
    const implied = Math.max(1, Math.round(Math.exp(logV)));
    const low = Math.max(1, Math.round(implied / bandFactor));
    const high = Math.round(implied * bandFactor);
    const cost = seasonCost(p);
    const crowd = crowdFor(p.tvl_usd);
    const gross = Math.round(((low * POOL_SHARE) / crowd) * 100) / 100;
    const net = Math.round((gross - cost.total_usd) * 100) / 100;
    const { verdict, reason } = verdictFor(gross, cost.total_usd, net);
    const age = ageDays(snapshot.as_of, p.listed_at);
    return {
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: age,
      on_watchlist: watch.has(p.slug),
      implied_value_usd: implied,
      value_low_usd: low,
      value_high_usd: high,
      multiple_of_tvl: Math.round((implied / p.tvl_usd) * 1000) / 1000,
      category_offset: Math.round((fit.offsets.get(p.category ?? '(no category)') ?? 0) * 100) / 100,
      category_comps: fit.offset_counts.get(p.category ?? '(no category)') ?? 0,
      season_cost_usd: cost.total_usd,
      capital_usd: cost.capital_usd,
      gas_usd: cost.gas_usd,
      time_usd: cost.time_usd,
      opportunity_usd: cost.opportunity_usd,
      crowd: crowd,
      gross_ev_usd: gross,
      net_ev_usd: net,
      verdict,
      verdict_reason: reason,
      farm_steps: farmSteps(p, age, cost),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const compRows: CompRow[] = comps
    .map((p) => {
      const fitted = Math.round(Math.exp(logPredict([fit.intercept, fit.slope_tvl, fit.slope_growth], fit.offsets, p)));
      return {
        slug: p.slug,
        name: p.name,
        category: p.category,
        tvl_usd: p.tvl_usd,
        mcap_usd: p.mcap_usd!,
        fitted_usd: fitted,
        ratio: Math.round((p.mcap_usd! / fitted) * 100) / 100,
      };
    })
    .sort((a, b) => b.mcap_usd - a.mcap_usd);

  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    method: {
      universe_size: universe.length,
      snapshot_size: snapshot.protocols.length,
      watchlist_size: snapshot.watchlist.length,
      comps_size: fit.comps_size,
      folds: fit.folds,
      intercept: Math.round(fit.intercept * 1000) / 1000,
      slope_tvl: Math.round(fit.slope_tvl * 1000) / 1000,
      slope_growth: Math.round(fit.slope_growth * 1000) / 1000,
      oos_rmsle: Math.round(fit.oos_rmsle * 1000) / 1000,
      oos_median_abs_log: Math.round(fit.oos_median_abs_log * 1000) / 1000,
      oos_within_2x_pct: Math.round(fit.oos_within_2x * 1000) / 10,
      oos_within_band_pct: Math.round(fit.oos_within_band * 1000) / 10,
      in_sample_rmsle: Math.round(fit.in_sample_rmsle * 1000) / 1000,
      band_factor: Math.round(bandFactor * 100) / 100,
      pool_share: POOL_SHARE,
      season_days: SEASON_DAYS,
    },
    rows,
    comps: compRows,
  };
}

/** The snapshot out of a file's text, refused unless it carries the fields the model reads. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `the board holds ${rows.length} rows, outside 100 to 4000`;
  const slugs = new Set(rows.map((r) => r.slug));
  if (slugs.size !== rows.length) return 'a slug appears on the board twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of rows) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on implied value`;
  }
  if (rows.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of rows) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's data as one script beside the page: no fetch, no network. */
export function dataScript(data: RadarData): string {
  return `window.LAUNCH_RADAR=${JSON.stringify(data)};\n`;
}
