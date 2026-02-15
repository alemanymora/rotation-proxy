const express = require('express');
const fetch   = require('node-fetch');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'The Rotation — Data Proxy', endpoints: ['/congress', '/insiders'] });
});

// ── CONGRESSIONAL TRADES ──────────────────────────────────────
app.get('/congress', async (req, res) => {
  try {
    // Try Capitol Trades API directly (they have a JSON API)
    const apiAttempts = [
      // Capitol Trades JSON API
      { url: 'https://api.capitoltrades.com/trades?pageSize=96&page=1', type: 'json' },
      // House Stock Watcher — dedicated free API, always allows server access
      { url: 'https://housestockwatcher.com/api/all_transactions.json', type: 'house' },
      // Senate Stock Watcher
      { url: 'https://senatestockwatcher.com/api/all_transactions.json', type: 'senate' },
    ];

    for (const attempt of apiAttempts) {
      try {
        const response = await fetch(attempt.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json, text/html, */*',
          },
          timeout: 12000,
        });

        if (!response.ok) continue;
        const data = await response.json();

        // House Stock Watcher format
        if (attempt.type === 'house' && Array.isArray(data)) {
          const cutoff = new Date(Date.now() - 60 * 86400 * 1000);
          const trades = data
            .filter(t => t.transaction_date && new Date(t.transaction_date) > cutoff)
            .slice(0, 60)
            .map(t => ({
              Representative: t.representative || 'Unknown',
              Party:          t.party || '?',
              Chamber:        'House',
              State:          t.state || '?',
              Ticker:         t.ticker || '?',
              Company:        t.asset_description || '?',
              Amount:         t.amount || 'Undisclosed',
              Date:           t.transaction_date || '',
              Filed:          t.disclosure_date || '',
              Transaction:    (t.type || '').toLowerCase().includes('purchase') ? 'Purchase' : 'Sale',
              Committee:      t.committee || '',
              AssetType:      t.asset_type || 'Stock',
            }));

          if (trades.length > 0) {
            return res.json({ success: true, count: trades.length, source: 'House Stock Watcher', trades });
          }
        }

        // Senate Stock Watcher format
        if (attempt.type === 'senate' && Array.isArray(data)) {
          const cutoff = new Date(Date.now() - 60 * 86400 * 1000);
          const trades = data
            .filter(t => t.transaction_date && new Date(t.transaction_date) > cutoff)
            .slice(0, 60)
            .map(t => ({
              Representative: t.senator || 'Unknown',
              Party:          t.party || '?',
              Chamber:        'Senate',
              State:          t.state || '?',
              Ticker:         t.ticker || '?',
              Company:        t.asset_description || '?',
              Amount:         t.amount || 'Undisclosed',
              Date:           t.transaction_date || '',
              Filed:          t.disclosure_date || '',
              Transaction:    (t.type || '').toLowerCase().includes('purchase') ? 'Purchase' : 'Sale',
              Committee:      '',
              AssetType:      t.asset_type || 'Stock',
            }));

          if (trades.length > 0) {
            return res.json({ success: true, count: trades.length, source: 'Senate Stock Watcher', trades });
          }
        }

        // Capitol Trades JSON API format
        if (attempt.type === 'json') {
          const trades = (data?.data || data?.trades || []).map(t => ({
            Representative: t.politician?.name || 'Unknown',
            Party:          t.politician?.party || '?',
            Chamber:        t.politician?.chamber || '?',
            State:          t.politician?.state || '?',
            Ticker:         t.issuer?.ticker || '?',
            Company:        t.issuer?.name || '?',
            Amount:         formatAmount(t.amount),
            Date:           t.txDate || t.reportedDate || '',
            Filed:          t.reportedDate || '',
            Transaction:    normalizeTransaction(t.type),
            Committee:      t.politician?.committees?.[0] || '',
            AssetType:      t.assetType || 'Stock',
          }));

          if (trades.length > 0) {
            return res.json({ success: true, count: trades.length, source: 'Capitol Trades', trades });
          }
        }

      } catch(e) {
        console.log('Attempt failed:', attempt.url, e.message);
        continue;
      }
    }

    // All attempts failed — try scraping Capitol Trades HTML with better selectors
    try {
      const response = await fetch('https://capitoltrades.com/trades', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        timeout: 15000,
      });

      const html = await response.text();

      // Log what we got for debugging
      console.log('Capitol Trades HTML length:', html.length);
      console.log('Has __NEXT_DATA__:', html.includes('__NEXT_DATA__'));
      console.log('Has "trades":', html.includes('"trades"'));

      // Try multiple JSON extraction patterns
      const patterns = [
        /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
        /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/,
        /"trades":\s*(\[[\s\S]*?\])\s*[,}]/,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (!match) continue;

        try {
          const parsed = JSON.parse(match[1]);
          // Navigate the data structure
          const possible = [
            parsed?.props?.pageProps?.trades?.data,
            parsed?.props?.pageProps?.trades,
            parsed?.trades?.data,
            parsed?.trades,
            parsed,
          ];

          for (const candidate of possible) {
            if (Array.isArray(candidate) && candidate.length > 0 && candidate[0].politician) {
              const trades = candidate.map(t => ({
                Representative: t.politician?.name || 'Unknown',
                Party:          t.politician?.party || '?',
                Chamber:        t.politician?.chamber || '?',
                Ticker:         t.issuer?.ticker || '?',
                Company:        t.issuer?.name || '?',
                Amount:         formatAmount(t.amount),
                Date:           t.txDate || t.reportedDate || '',
                Filed:          t.reportedDate || '',
                Transaction:    normalizeTransaction(t.type),
                Committee:      t.politician?.committees?.[0] || '',
              }));
              return res.json({ success: true, count: trades.length, source: 'Capitol Trades (HTML)', trades });
            }
          }
        } catch(e) { continue; }
      }

      // Return raw debug info so we can see what structure Capitol Trades is using
      const snippet = html.substring(0, 2000);
      return res.status(500).json({
        error: 'Could not parse Capitol Trades',
        htmlLength: html.length,
        hasNextData: html.includes('__NEXT_DATA__'),
        snippet: snippet
      });

    } catch(e) {
      return res.status(500).json({ error: 'All sources failed: ' + e.message });
    }

  } catch (err) {
    console.error('Congress error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── INSIDER TRADES (OpenInsider) ──────────────────────────────
app.get('/insiders', async (req, res) => {
  try {
    const url = 'https://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=30&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&xs=1&vl=100&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=100&Action=Submit&action=1';

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    });

    if (!response.ok) return res.status(response.status).json({ error: 'OpenInsider returned ' + response.status });

    const html  = await response.text();
    const rows  = html.match(/<tr[^>]*class="[^"]*odd[^"]*"[^>]*>[\s\S]*?<\/tr>|<tr[^>]*class="[^"]*even[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || [];
    const strip = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&#39;/g,"'").trim();

    const trades = [];
    rows.forEach(row => {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c => strip(c.replace(/<td[^>]*>/i,'').replace(/<\/td>/i,'')));
      if (cells.length < 11) return;
      const value = parseFloat((cells[11] || '0').replace(/[$,+]/g, '')) * 1000;
      if (value < 50000) return;
      trades.push({
        date:    cells[1]  || '',
        ticker:  cells[3]  || '',
        company: cells[4]  || '',
        name:    cells[5]  || '',
        role:    cells[6]  || '',
        type:    (cells[7] || '').startsWith('P') ? 'Purchase' : 'Sale',
        price:   parseFloat((cells[8]  || '0').replace(/[$,]/g,'')),
        shares:  parseInt((cells[9]   || '0').replace(/[+,]/g,'')),
        value:   value,
      });
    });

    // Cluster by ticker
    const byTicker = {};
    trades.forEach(t => {
      if (!byTicker[t.ticker]) byTicker[t.ticker] = { ticker:t.ticker, company:t.company, buys:[], sells:[] };
      if (t.type === 'Purchase') byTicker[t.ticker].buys.push(t);
      else byTicker[t.ticker].sells.push(t);
    });

    const clustered = Object.values(byTicker)
      .sort((a,b) => (b.buys.length + b.sells.length) - (a.buys.length + a.sells.length))
      .slice(0, 30);

    res.json({ success: true, count: trades.length, source: 'OpenInsider', trades: trades.slice(0,100), clustered });

  } catch (err) {
    console.error('Insiders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ───────────────────────────────────────────────────
function formatAmount(amount) {
  if (!amount) return 'Undisclosed';
  if (typeof amount === 'string') return amount;
  if (typeof amount === 'number') {
    if (amount >= 1e6) return '$' + (amount/1e6).toFixed(1) + 'M';
    if (amount >= 1e3) return '$' + (amount/1e3).toFixed(0) + 'K';
    return '$' + amount;
  }
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
  return type;
}

app.listen(PORT, () => console.log('The Rotation proxy running on port ' + PORT));
