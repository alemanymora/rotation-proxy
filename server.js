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
  res.json({ status: 'ok', service: 'The Rotation — Data Proxy', endpoints: ['/congress', '/insiders', '/debug'] });
});

// ── DEBUG — test every source and report results ──────────────
app.get('/debug', async (req, res) => {
  const results = {};

  const sources = [
    { name: 'house_xml', url: 'https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.xml' },
    { name: 'house_xml_2025', url: 'https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2025FD.xml' },
    { name: 'house_ptr', url: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20026448.xml' },
    { name: 'unusual_whales', url: 'https://api.unusualwhales.com/api/congress/trades?limit=5' },
    { name: 'openinsider', url: 'https://openinsider.com/screener?cnt=5&Action=Submit&action=1' },
    { name: 'sec_edgar', url: 'https://data.sec.gov/submissions/CIK0000320193.json' },
  ];

  for (const src of sources) {
    try {
      const res2 = await fetch(src.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 TheRotation/1.0' },
        timeout: 8000,
      });
      const text = await res2.text();
      results[src.name] = {
        status: res2.status,
        ok: res2.ok,
        length: text.length,
        preview: text.slice(0, 200),
      };
    } catch(e) {
      results[src.name] = { error: e.message };
    }
  }

  res.json(results);
});

// ── CONGRESSIONAL TRADES ──────────────────────────────────────
app.get('/congress', async (req, res) => {
  try {
    const results = [];

    // ── Source 1: House XML (official government disclosure files) ──
    for (const year of [2026, 2025]) {
      try {
        const url = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`;
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 TheRotation/1.0' },
          timeout: 20000,
        });
        if (!r.ok) { console.log('House XML', year, 'status:', r.status); continue; }
        const xml = await r.text();
        console.log('House XML', year, 'length:', xml.length);

        const members = xml.match(/<Member>([\s\S]*?)<\/Member>/gi) || [];
        console.log('Members found:', members.length);

        const cutoff = Date.now() - 90 * 86400 * 1000;
        members.forEach(m => {
          const get = tag => { const x = m.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>', 'i')); return x ? x[1].trim() : ''; };
          const docType = get('DocType');
          const date = get('FilingDate') || get('Year') || '';
          if (!docType.toUpperCase().includes('PTR')) return;
          if (date && new Date(date).getTime() < cutoff) return;
          const ticker = get('Ticker') || get('ticker') || '?';
          results.push({
            Representative: get('Name') || get('First') + ' ' + get('Last'),
            Party: '?', Chamber: 'House',
            Ticker: ticker, Company: get('AssetDescription') || 'See filing',
            Amount: get('Amount') || 'Undisclosed',
            Date: date, Filed: date,
            Transaction: get('Type') || 'Purchase',
            Committee: '',
          });
        });
        if (results.length > 5) break;
      } catch(e) { console.log('House XML error:', e.message); }
    }

    // ── Source 2: Unusual Whales (popular finance site) ──
    if (results.length === 0) {
      try {
        const r = await fetch('https://api.unusualwhales.com/api/congress/trades?limit=50', {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          timeout: 10000,
        });
        console.log('Unusual Whales status:', r.status);
        if (r.ok) {
          const data = await r.json();
          const trades = data?.data || data?.trades || (Array.isArray(data) ? data : []);
          console.log('UW trades count:', trades.length);
          trades.slice(0, 60).forEach(t => {
            results.push({
              Representative: t.representative || t.politician_name || t.name || 'Unknown',
              Party: t.party || '?', Chamber: t.chamber || '?',
              Ticker: t.ticker || t.symbol || '?',
              Company: t.issuer_name || t.company || '?',
              Amount: t.amount || t.trade_size || 'Undisclosed',
              Date: t.traded_at || t.transaction_date || t.date || '',
              Filed: t.filed_at || t.disclosure_date || '',
              Transaction: (t.type||'').toLowerCase().includes('buy') ||
                           (t.type||'').toLowerCase().includes('purchase') ? 'Purchase' : 'Sale',
              Committee: '',
            });
          });
        }
      } catch(e) { console.log('Unusual Whales error:', e.message); }
    }

    // ── Source 3: SEC EDGAR company facts (backup) ──
    if (results.length === 0) {
      return res.status(404).json({
        error: 'No congressional trade data available',
        tried: ['House Disclosures XML 2026/2025', 'Unusual Whales'],
        suggestion: 'Visit /debug to see which sources are reachable'
      });
    }

    results.sort((a, b) => new Date(b.Date) - new Date(a.Date));
    res.json({ success: true, count: results.length, source: 'US House Disclosures', trades: results.slice(0, 80) });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INSIDER TRADES (OpenInsider) ──────────────────────────────
app.get('/insiders', async (req, res) => {
  try {
    const url = 'https://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=30&fdr=&td=0&tdr=&xp=1&xs=1&vl=100&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&cnt=100&Action=Submit&action=1';
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' },
      timeout: 15000,
    });
    if (!r.ok) return res.status(r.status).json({ error: 'OpenInsider returned ' + r.status });

    const html  = await r.text();
    const strip = s => s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();
    const table = html.match(/<table[^>]*class="[^"]*tinytable[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
    if (!table) return res.status(500).json({ error: 'Table not found', htmlLength: html.length });

    const rows = table[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    const trades = [];
    rows.forEach((row, i) => {
      if (i === 0) return;
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi)||[]).map(c => strip(c.replace(/<td[^>]*>/i,'').replace(/<\/td>/i,'')));
      if (cells.length < 10) return;
      const value = parseFloat((cells[11]||cells[10]||'0').replace(/[$,+]/g,'')) * 1000;
      if (value < 50000) return;
      trades.push({
        date: cells[1]||'', ticker: cells[3]||'', company: cells[4]||'',
        name: cells[5]||'', role: cells[6]||'',
        type: (cells[7]||'').startsWith('P') ? 'Purchase' : 'Sale',
        price: parseFloat((cells[8]||'0').replace(/[$,]/g,'')),
        shares: parseInt((cells[9]||'0').replace(/[+,]/g,''))||0,
        value,
      });
    });

    const byTicker = {};
    trades.forEach(t => {
      if (!t.ticker) return;
      if (!byTicker[t.ticker]) byTicker[t.ticker] = { ticker: t.ticker, company: t.company, buys: [], sells: [] };
      if (t.type === 'Purchase') byTicker[t.ticker].buys.push(t);
      else byTicker[t.ticker].sells.push(t);
    });
    const clustered = Object.values(byTicker).sort((a,b)=>(b.buys.length+b.sells.length)-(a.buys.length+a.sells.length)).slice(0,30);
    res.json({ success: true, count: trades.length, source: 'OpenInsider', trades: trades.slice(0,100), clustered });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('The Rotation proxy running on port ' + PORT));
