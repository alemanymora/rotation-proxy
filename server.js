const express = require('express');
const fetch   = require('node-fetch');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── CORS — allow your Mission Control HTML file to call this ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'The Rotation — Data Proxy',
    endpoints: ['/congress', '/insiders'],
    updated: new Date().toISOString()
  });
});

// ── CONGRESSIONAL TRADES (Capitol Trades) ────────────────────
app.get('/congress', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const url  = `https://capitoltrades.com/trades?pageSize=96&page=${page}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer':    'https://capitoltrades.com/',
      },
      timeout: 15000,
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Capitol Trades returned ' + response.status });
    }

    const html = await response.text();

    // Extract Next.js embedded JSON data
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
      return res.status(500).json({ error: 'Could not find trade data in page' });
    }

    const pageData = JSON.parse(match[1]);
    const trades   = pageData?.props?.pageProps?.trades?.data || [];

    if (trades.length === 0) {
      return res.status(404).json({ error: 'No trades found', raw_keys: Object.keys(pageData?.props?.pageProps || {}) });
    }

    // Normalize to our standard format
    const normalized = trades.map(t => ({
      Representative: t.politician?.name          || 'Unknown',
      Party:          t.politician?.party         || '?',
      Chamber:        t.politician?.chamber       || '?',
      State:          t.politician?.state         || '?',
      Ticker:         t.issuer?.ticker            || t.ticker || '?',
      Company:        t.issuer?.name              || '?',
      Amount:         formatAmount(t.amount),
      Date:           t.txDate                    || t.reportedDate || '',
      Filed:          t.reportedDate              || '',
      Transaction:    normalizeTransaction(t.type),
      Committee:      t.politician?.committees?.[0] || '',
      AssetType:      t.assetType                 || 'Stock',
    }));

    res.json({
      success: true,
      count:   normalized.length,
      source:  'Capitol Trades',
      trades:  normalized,
    });

  } catch (err) {
    console.error('Congress error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── INSIDER TRADES (SEC EDGAR Form 4) ────────────────────────
app.get('/insiders', async (req, res) => {
  try {
    const days    = parseInt(req.query.days || '30');
    const minVal  = parseInt(req.query.minval || '100000');
    const today   = new Date();
    const startDt = new Date(today - days * 86400 * 1000).toISOString().slice(0, 10);
    const endDt   = today.toISOString().slice(0, 10);

    // SEC EDGAR full-text search for Form 4
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22form+4%22&dateRange=custom&startdt=${startDt}&enddt=${endDt}&hits.hits.total.value=true&hits.hits._source.period_of_report=true&hits.hits._source.entity_name=true&hits.hits._source.file_date=true&hits.hits._source.file_num=true`;

    const searchRes = await fetch(url, {
      headers: { 'User-Agent': 'TheRotation newsletter@therotation.com' },
      timeout: 15000,
    });

    if (!searchRes.ok) {
      return res.status(searchRes.status).json({ error: 'EDGAR returned ' + searchRes.status });
    }

    const searchData = await searchRes.json();
    const hits = searchData?.hits?.hits || [];

    if (hits.length === 0) {
      return res.json({ success: true, count: 0, trades: [] });
    }

    // For each filing, fetch the actual XML to get trade details
    // (limit to first 20 to avoid timeout)
    const tradeDetails = [];
    const filingPromises = hits.slice(0, 20).map(async hit => {
      try {
        const accNum = hit._id?.replace(/:/g, '-') || '';
        const entity = hit._source?.entity_name || '';
        const fileDate = hit._source?.file_date || '';
        if (!accNum) return null;

        // Fetch the filing index
        const accFormatted = accNum.replace(/-/g, '');
        const cik = accNum.split('-')[0].padStart(10, '0');
        const indexUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accFormatted}/`;

        return {
          entity,
          fileDate,
          accNum,
          url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${hit._source?.file_num || ''}&type=4&dateb=&owner=include&count=10`,
        };
      } catch(e) { return null; }
    });

    const results = (await Promise.all(filingPromises)).filter(Boolean);

    res.json({
      success: true,
      count:   results.length,
      source:  'SEC EDGAR',
      note:    'Form 4 filings index — use /insiders/parsed for full trade details',
      filings: results,
    });

  } catch (err) {
    console.error('Insiders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── INSIDER TRADES — OpenInsider (better structured data) ────
app.get('/insiders/parsed', async (req, res) => {
  try {
    // OpenInsider has clean structured data for large insider trades
    const url = 'https://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=30&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&xs=1&vl=100&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=100&Action=Submit&action=1';

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'OpenInsider returned ' + response.status });
    }

    const html     = await response.text();
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const stripHtml = s => s.replace(/<[^>]+>/g, '').trim();

    const trades = [];
    let rowMatch;
    let isFirstRow = true;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      if (isFirstRow) { isFirstRow = false; continue; } // skip header

      const cells = [];
      let cellMatch;
      const cellContent = rowMatch[1];
      const tempRegex   = /<td[^>]*>([\s\S]*?)<\/td>/gi;

      while ((cellMatch = tempRegex.exec(cellContent)) !== null) {
        cells.push(stripHtml(cellMatch[1]));
      }

      if (cells.length < 11) continue;

      const value = parseFloat((cells[11] || '0').replace(/[$,+]/g, '')) * 1000;
      if (value < 50000) continue; // filter tiny trades

      trades.push({
        date:     cells[1]  || '',
        ticker:   cells[3]  || '',
        company:  cells[4]  || '',
        name:     cells[5]  || '',
        role:     cells[6]  || '',
        type:     (cells[7] || '').startsWith('P') ? 'Purchase' : 'Sale',
        price:    parseFloat((cells[8]  || '0').replace(/[$,]/g, '')),
        shares:   parseInt((cells[9]   || '0').replace(/[+,]/g, '')),
        value:    value,
        sharesTotal: parseInt((cells[10] || '0').replace(/[,]/g, '')),
      });
    }

    // Cluster by ticker
    const byTicker = {};
    trades.forEach(t => {
      if (!byTicker[t.ticker]) byTicker[t.ticker] = {
        ticker: t.ticker, company: t.company,
        buys: [], sells: [],
      };
      if (t.type === 'Purchase') byTicker[t.ticker].buys.push(t);
      else byTicker[t.ticker].sells.push(t);
    });

    const clustered = Object.values(byTicker)
      .sort((a, b) => (b.buys.length + b.sells.length) - (a.buys.length + a.sells.length))
      .slice(0, 30);

    res.json({
      success:  true,
      count:    trades.length,
      source:   'OpenInsider',
      trades:   trades.slice(0, 100),
      clustered: clustered,
    });

  } catch (err) {
    console.error('Insiders/parsed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ──────────────────────────────────────────────────
function formatAmount(amount) {
  if (!amount) return 'Undisclosed';
  if (typeof amount === 'string') return amount;
  if (typeof amount === 'number') {
    if (amount >= 1e6) return '$' + (amount/1e6).toFixed(1) + 'M';
    if (amount >= 1e3) return '$' + (amount/1e3).toFixed(0) + 'K';
    return '$' + amount;
  }
  // Range object {min, max}
  if (amount.min !== undefined) {
    const fmt = v => v >= 1e6 ? '$' + (v/1e6).toFixed(0) + 'M' : '$' + (v/1e3).toFixed(0) + 'K';
    return fmt(amount.min) + '–' + fmt(amount.max);
  }
  return String(amount);
}

function normalizeTransaction(type) {
  if (!type) return 'Unknown';
  const t = type.toLowerCase();
  if (t.includes('buy') || t.includes('purchase')) return 'Purchase';
  if (t.includes('sell') || t.includes('sale'))    return 'Sale';
  if (t.includes('exchange'))                       return 'Exchange';
  return type;
}

app.listen(PORT, () => {
  console.log('The Rotation proxy running on port ' + PORT);
});
