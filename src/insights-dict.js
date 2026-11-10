// Dictionaries for Channel Insights: which assets and indicators a channel post talks about.
// Built from the channel's own vocabulary (Jan–Sep 2026 export): hashtags first, then tickers and names.

// canonical -> { cls, alias: extra spellings (matched case-insensitively as whole words) }
export const ASSETS = {
  // crypto
  BTC: { cls: 'crypto', alias: ['bitcoin', 'биткойн', 'биткоин'] }, ETH: { cls: 'crypto', alias: ['ethereum', 'ether'] },
  SOL: { cls: 'crypto', alias: ['solana'] }, BNB: { cls: 'crypto', alias: [] }, XRP: { cls: 'crypto', alias: ['ripple'] },
  HYPE: { cls: 'crypto', alias: ['hyperliquid'] }, ZEC: { cls: 'crypto', alias: ['zcash'] }, XMR: { cls: 'crypto', alias: ['monero'] },
  XPL: { cls: 'crypto', alias: ['plasma'] }, TON: { cls: 'crypto', alias: ['toncoin'] }, SUI: { cls: 'crypto', alias: [] },
  NEAR: { cls: 'crypto', alias: [] }, CAKE: { cls: 'crypto', alias: ['pancakeswap'] }, PENGU: { cls: 'crypto', alias: ['pudgy penguins'] },
  IO: { cls: 'crypto', alias: [] }, TAO: { cls: 'crypto', alias: ['bittensor'] }, ADA: { cls: 'crypto', alias: ['cardano'] },
  DOGE: { cls: 'crypto', alias: ['dogecoin'] }, LINK: { cls: 'crypto', alias: ['chainlink'] }, AVAX: { cls: 'crypto', alias: ['avalanche'] },
  AAVE: { cls: 'crypto', alias: [] }, OTHERS: { cls: 'crypto', alias: [] },
  // stocks
  MSFT: { cls: 'stock', alias: ['microsoft'] }, XOM: { cls: 'stock', alias: ['exxon', 'exxonmobil'] }, NFLX: { cls: 'stock', alias: ['netflix'] },
  AAPL: { cls: 'stock', alias: ['apple'] }, ALB: { cls: 'stock', alias: ['albemarle'] }, SPCX: { cls: 'stock', alias: ['spacex'] },
  META: { cls: 'stock', alias: [] }, JD: { cls: 'stock', alias: [] }, CRWV: { cls: 'stock', alias: ['coreweave'] },
  INTC: { cls: 'stock', alias: ['intel'] }, PLTR: { cls: 'stock', alias: ['palantir'] }, NBIS: { cls: 'stock', alias: ['nebius'] },
  CORZ: { cls: 'stock', alias: ['core scientific'] }, NVDA: { cls: 'stock', alias: ['nvidia'] }, MSTR: { cls: 'stock', alias: ['microstrategy'] },
  APLD: { cls: 'stock', alias: ['applied digital'] }, TSLA: { cls: 'stock', alias: ['tesla'] }, IREN: { cls: 'stock', alias: [] },
  LAC: { cls: 'stock', alias: ['lithium americas'] }, GME: { cls: 'stock', alias: ['gamestop'] }, ORCL: { cls: 'stock', alias: ['oracle'] },
  AMZN: { cls: 'stock', alias: ['amazon'] }, OKLO: { cls: 'stock', alias: [] }, AVGO: { cls: 'stock', alias: ['broadcom'] },
  MU: { cls: 'stock', alias: ['micron'] }, PYPL: { cls: 'stock', alias: ['paypal'] }, BABA: { cls: 'stock', alias: ['alibaba'] },
  SNDK: { cls: 'stock', alias: ['sandisk'] }, IBM: { cls: 'stock', alias: [] }, AMD: { cls: 'stock', alias: [] },
  GOOGL: { cls: 'stock', alias: ['google', 'alphabet'] }, COIN: { cls: 'stock', alias: ['coinbase'] },
  // ETFs
  XLE: { cls: 'etf', alias: [] }, QQQ: { cls: 'etf', alias: [] }, XOP: { cls: 'etf', alias: [] }, TLT: { cls: 'etf', alias: [] }, SPY: { cls: 'etf', alias: [] },
  // indices
  SPX: { cls: 'index', alias: ['s&p 500', 's&p500', 'sp500'] }, DOW: { cls: 'index', alias: ['dow jones', 'djia', 'dji'] },
  NASDAQ: { cls: 'index', alias: ['nasdaq 100', 'ndx', 'ndq', 'ixic', 'nas100'] },
  // commodities
  GOLD: { cls: 'commodity', alias: ['xau', 'xauusd'] }, SILVER: { cls: 'commodity', alias: ['xag', 'xagusd'] },
  PALL: { cls: 'commodity', alias: ['palladium'] }, PLAT: { cls: 'commodity', alias: ['platinum'] },
  WTI: { cls: 'commodity', alias: ['usoil', 'crude oil', 'wti'] }, BRENT: { cls: 'commodity', alias: ['ukoil', 'brent'] },
  OIL: { cls: 'commodity', alias: [] }, NATGAS: { cls: 'commodity', alias: ['natural gas'] }, CORN: { cls: 'commodity', alias: [] },
  // macro
  DXY: { cls: 'macro', alias: ['dollar index'] }, US10Y: { cls: 'macro', alias: ['10-year yield', '10y yield'] },
  USINTR: { cls: 'macro', alias: ['interest rate', 'fed funds'] },
};
// hashtag spellings that point at a canonical asset
export const TAG_ALIAS = {
  USOIL: 'WTI', UKOIL: 'BRENT', EXXON: 'XOM', BROADCOM: 'AVGO', NDQ: 'NASDAQ', IXIC: 'NASDAQ', DJI: 'DOW', DJIA: 'DOW',
  SP500: 'SPX', XAU: 'GOLD', XAG: 'SILVER', PALLADIUM: 'PALL', PLATINUM: 'PLAT', BITCOIN: 'BTC', ETHEREUM: 'ETH',
};
// hashtags that are themes, not a single asset
export const THEMES = new Set(['ENERGY', 'DYOR', 'METALS', 'METLAS', 'SEMI', 'SEMIS', 'SEMICONDUCTORS', 'AI', 'ALTS', 'ALT', 'CRYPTO',
  'STOCKS', 'STCOKS', 'LA', 'LAX', 'MEMORY', 'ATHS', 'MEME', 'GRAM', 'TECH', 'MACRO', 'NEWS', 'UPDATE', 'TA', 'MAG7', 'IPO', 'FED',
  'CPI', 'FOMC', 'BMSB', 'DCA']);
// tickers that are also common English words: only count them as #TAG, $TAG or written in CAPITALS
export const AMBIGUOUS = new Set(['IO', 'LINK', 'TON', 'META', 'GOLD', 'SILVER', 'OIL', 'DOW', 'COIN', 'NEAR', 'CAKE', 'HYPE', 'MU', 'JD', 'ALB', 'CORN', 'PLAT', 'OTHERS', 'AAVE', 'SUI']);

// canonical indicator -> regexes (case-insensitive unless the pattern says otherwise)
export const INDICATORS = [
  ['BMSB', [/\bBMSB\b/i, /bull market support band/i]],
  ['SMA', [/\bSMA\b/i, /simple moving average/i]],
  ['EMA', [/\bEMA\b/i, /exponential moving average/i]],
  ['RSI', [/\bRSI\b/i, /relative strength index/i]],
  ['Stoch RSI', [/\bstoch(?:astic)?(?:\s*rsi)?\b/i]],
  ['Divergence', [/\bdivergen(?:ce|t|ces)\b/i]],
  ['Support', [/(?<!market )\bsupports?\b/i]],
  ['Resistance', [/\bresistances?\b/i]],
  ['Trendline', [/\btrend\s?-?lines?\b/i]],
  ['Retest', [/\bre-?test(?:s|ed|ing)?\b/i]],
  ['Breakout', [/\bbreak-?outs?\b/i, /\bbreak(?:s|ing)? (?:out|above|below)\b/i]],
  ['Volume Profile', [/\bPOC\b/, /\bVAH\b/, /\bVAL\b/, /value area/i, /volume profile/i]],
  ['Fibonacci', [/\bfib(?:onacci|s)?\b/i, /golden pocket/i]],
  ['Liquidity', [/\bliquidity\b/i]],
  ['FVG', [/\bFVG\b/i, /fair value gap/i, /\bimbalance\b/i]],
  ['Order Block', [/\border\s?blocks?\b/i]],
  ['Flag', [/\b(?:bull|bear)(?:ish)? flags?\b/i, /\bflag pattern\b/i, /\bflags?\b/i]],
  ['Wedge', [/\bwedges?\b/i]],
  ['Double Top/Bottom', [/\bdouble (?:top|bottom)s?\b/i]],
  ['Head & Shoulders', [/\bhead (?:and|&) shoulders\b/i, /\bH&S\b/]],
  ['Triangle', [/\btriangles?\b/i]],
  ['Channel', [/\b(?:ascending|descending|parallel|rising|falling|price|up|down)\s?channel\b/i, /\bchannel (?:top|bottom|low|high|support|resistance)\b/i]],
  ['Range', [/\brange (?:high|low|top|bottom)s?\b/i, /\btrading range\b/i, /\b(?:in|out of|inside) (?:the|a) range\b/i]],
  ['Risk Metric', [/\brisk (?:metric|level|indicator|model)\b/i]],
  ['Market Cycle', [/\bcycles?\b/i, /\bbear market\b/i, /\bbull market\b(?! support band)/i]],
  ['Accumulation', [/\baccumulat(?:e|es|ed|ing|ion)\b/i]],
  ['Distribution', [/\bdistribution\b/i]],
  ['Capitulation', [/\bcapitulat(?:e|es|ed|ing|ion)\b/i]],
  ['Risk:Reward', [/\bRR\b/, /\bR:R\b/i, /risk[ -/:]reward/i]],
  ['Golden/Death Cross', [/\b(?:golden|death) cross\b/i]],
  ['Fear & Greed', [/fear (?:&|and) greed/i]],
  ['VWAP', [/\bVWAP\b/i]],
];

// moving-average variants written like "50W SMA", "200D EMA", "SMA 200", "21 week EMA"
export const MA_VARIANT = /\b(\d{1,3})\s?-?\s?(D|W|M|day|week|month)?\s?-?\s?(SMA|EMA)\b|\b(SMA|EMA)\s?-?\s?(\d{1,3})\s?(D|W|M)?\b/gi;
export function maVariant(m) {
  const n = m[1] || m[5], tf = (m[2] || m[6] || '').toUpperCase(), kind = (m[3] || m[4]).toUpperCase();
  const t = tf.startsWith('W') ? 'W' : tf.startsWith('M') ? 'M' : tf ? 'D' : '';
  return `${n}${t} ${kind}`;
}
