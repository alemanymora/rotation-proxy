const express = require('express');
const fetch   = require('node-fetch');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'The Rotation — Data Proxy', endpoints: ['/congress', '/insiders'] });
});

// ── CONGRESSIONAL TRADES ──────────────────────────────────────
// Uses House Stock Watcher + Senate Stock Watcher
// These are community-maintained APIs built specifically for browser/server access
app.get('/congress', async (req, res) => {
  try {
    const results = [];

    // Fetch House trades
    try {
      const houseRes = await fetch('https://housestockwatcher.com/api/all_transactions.json', {
        headers: { 'User-Agent': 'TheRotation/1.0 newsletter bot' },
        timeout: 15000,
      });
      if (houseRes.ok) {
        const data = await houseRes.json();
        console.log('House data type:', typeof data, Array.isArray(data) ? 'array len=' + data.length : 'not array');
        console.log('House first item keys:', data?.[0] ? Object.keys(data[0]).join(',') : 'none');

        const arr = Array.isArray(data) ? data : (data.data || data.transactions || []);
        const cutoff = Date.now() - 90 * 86400 * 1000;

        arr.forEach(t => {
          const dateStr = t.transaction_date || t.disclosure_date || t.date || '';
          if (dateStr && new Date(dateStr).getTime() < cutoff) return;
          const ticker = (t.ticker || '').replace(/\$/g, '').trim();
          if (!ticker || ticker === 'N/A' || ticker.length > 6) return;
          results.push({
            Representative: t.representative || t.name || 'Unknown',
            Party:          t.party || '?',
            Chamber:        'House',
            State:          t.state || '?',
            Ticker:         ticker,
            Company:        t.asset_description || t.company || '?',
            Amount:         t.amount || 'Undisclosed',
            Date:           dateStr,
            Filed:          t.disclosure_date || dateStr,
            Transaction:    (t.type || t.transaction_type || '').toLowerCase().includes('purchase') ? 'Purchase' : 'Sale',
            Committee:      '',
          });
        });
        console.log('House trades added:', results.length);
      }
    } catch(e) { console.log('House fetch error:', e.message); }

    // Fetch Senate trades
    try {
      const senateRes = await fetch('https://senatestockwatcher.com/api/all_transactions.json', {
        headers: { 'User-Agent': 'TheRotation/1.0 newsletter bot' },
        timeout: 15000,
      });
      if (senateRes.ok) {
        const data = await senateRes.json();
        console.log('Senate data type:', typeof data, Array.isArray(data) ? 'array len=' + data.length : 'not array');

        const arr = Array.isArray(data) ? data : (data.data || data.transactions || []);
        const cutoff = Date.now() - 90 * 86400 * 1000;
        const beforeCount = results.length;

        arr.forEach(t => {
          const dateStr = t.transaction_date || t.disclosure_date || t.date || '';
          if (dateStr && new Date(dateStr).getTime() < cutoff) return;
          const ticker = (t.ticker || '').replace(/\$/g, '').trim();
          if (!ticker || ticker === 'N/A' || ticker.length > 6) return;
          results.push({
            Representative: t.senator || t.first_name + ' ' + t.last_name || 'Unknown',
            Party:          t.party || '?',
            Chamber:        'Senate',
            State:          t.state || '?',
            Ticker:         ticker,
            Company:        t.asset_description || t.company || '?',
            Amount:         t.amount || 'Undisclosed',
            Date:           dateStr,
            Filed:          t.disclosure_date || dateStr,
            Transaction:    (t.type || t.transaction_type || '').toLowerCase().includes('purchase') ? 'Purchase' : 'Sale',
            Committee:      '',
          });
        });
        console.log('Senate trades added:', results.length - beforeCount);
      }
    } catch(e) { console.log('Senate fetch error:', e.message); }

    if (results.length === 0) {
      return res.status(404).json({ error: 'No trades found from any source', note: 'Check Render logs for details' });
    }

    // Sort by date descending, take most recent 80
    results.sort((a, b) => new Date(b.Date) - new Date(a.Date));
    const recent = results.slice(0, 80);

    res.json({
      success: true,
      count:   recent.length,
      source:  'House Stock Watcher + Senate Stock Watcher',
      trades:  recent,
    });

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
    const strip = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();

    // Find the main table
    const tableMatch = html.match(/<table[^>]*class="[^"]*tinytable[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) {
      return res.status(500).json({ error: 'Could not find insider trades table', htmlLength: html.length });
    }

    const rows = tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    const trades = [];

    rows.forEach((row, idx) => {
      if (idx === 0) return; // skip header
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c =>
        strip(c.replace(/<td[^>]*>/i, '').replace(/<\/td>/i, ''))
      );
      if (cells.length < 10) return;

      const value = parseFloat((cells[11] || cells[10] || '0').replace(/[$,+]/g, '')) * 1000;
      if (value < 50000) return;

      trades.push({
        date:    cells[1]  || '',
        ticker:  cells[3]  || '',
        company: cells[4]  || '',
        name:    cells[5]  || '',
        role:    cells[6]  || '',
        type:    (cells[7] || '').startsWith('P') ? 'Purchase' : 'Sale',
        price:   parseFloat((cells[8]  || '0').replace(/[$,]/g, '')),
        shares:  parseInt((cells[9]   || '0').replace(/[+,]/g, '')) || 0,
        value:   value,
      });
    });

    // Cluster by ticker
    const byTicker = {};
    trades.forEach(t => {
      if (!t.ticker) return;
      if (!byTicker[t.ticker]) byTicker[t.ticker] = { ticker: t.ticker, company: t.company, buys: [], sells: [] };
      if (t.type === 'Purchase') byTicker[t.ticker].buys.push(t);
      else byTicker[t.ticker].sells.push(t);
    });

    const clustered = Object.values(byTicker)
      .sort((a, b) => (b.buys.length + b.sells.length) - (a.buys.length + a.sells.length))
      .slice(0, 30);

    res.json({ success: true, count: trades.length, source: 'OpenInsider', trades: trades.slice(0, 100), clustered });

  } catch (err) {
    console.error('Insiders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('The Rotation proxy running on port ' + PORT));
