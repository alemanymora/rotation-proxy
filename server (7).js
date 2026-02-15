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
// Source: Official House of Representatives XML disclosure files
// Updated daily at disclosures-clerk.house.gov
app.get('/congress', async (req, res) => {
  try {
    const results = [];

    for (const year of [2026, 2025]) {
      try {
        const url = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`;
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 TheRotation/1.0' },
          timeout: 20000,
        });
        if (!r.ok) continue;
        const xml = await r.text();

        // Each <Member> block is one filing
        const members = xml.match(/<Member>([\s\S]*?)<\/Member>/gi) || [];
        console.log(`Year ${year}: ${members.length} filings found`);

        const cutoff = Date.now() - 90 * 86400 * 1000;

        members.forEach(m => {
          const get = tag => {
            const x = m.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>', 'i'));
            return x ? x[1].trim() : '';
          };

          // FilingType P = Periodic Transaction Report (actual stock trades)
          // FilingType A = Annual report (not what we want)
          // FilingType D = Due date
          const filingType = get('FilingType');
          if (filingType !== 'P') return;

          const filedDate = get('FilingDate') || (year + '-01-01');
          if (new Date(filedDate).getTime() < cutoff) return;

          const first = get('First');
          const last  = get('Last');
          const docId = get('DocID');

          results.push({
            Representative: first + ' ' + last,
            Party:          '?',
            Chamber:        'House',
            State:          get('StateDst') || '?',
            Ticker:         '?',
            Company:        'Multiple — see filing',
            Amount:         'See filing',
            Date:           filedDate,
            Filed:          filedDate,
            Transaction:    'Purchase/Sale',
            Committee:      '',
            FilingUrl:      `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`,
          });
        });

        console.log(`Total results after ${year}:`, results.length);
        if (results.length >= 20) break;

      } catch(e) {
        console.log('House XML error:', e.message);
      }
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'No filings found' });
    }

    // Sort by date descending
    results.sort((a, b) => new Date(b.Date) - new Date(a.Date));

    res.json({
      success: true,
      count:   results.length,
      source:  'US House of Representatives — Official Financial Disclosures',
      note:    'These are Periodic Transaction Reports (PTR) — mandatory within 30-45 days of each trade',
      trades:  results.slice(0, 60),
    });

  } catch(err) {
    console.error('Congress error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── INSIDER TRADES (SEC EDGAR) ────────────────────────────────
// Source: SEC EDGAR — official government database
// Form 4 = insider buy/sell, mandatory within 2 business days
app.get('/insiders', async (req, res) => {
  try {
    // Most active insider trading tickers to check
    // We'll get recent Form 4 filings for major stocks
    const WATCH_TICKERS = [
      'NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA',
      'JPM','GS','BAC','XOM','CVX','LMT','RTX','NOC',
      'UNH','JNJ','PFE','AMD','INTC','ORCL','CRM','NFLX',
    ];

    const results = [];

    // SEC EDGAR company search to get CIK numbers, then fetch submissions
    // Use the EDGAR full-text search for recent Form 4 filings
    const today   = new Date().toISOString().slice(0, 10);
    const ago30   = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22form+4%22&dateRange=custom&startdt=${ago30}&enddt=${today}&hits.hits.total.value=true`;

    const r = await fetch(searchUrl, {
      headers: { 'User-Agent': 'TheRotation newsletter@therotation.com' },
      timeout: 15000,
    });

    console.log('EDGAR search status:', r.status);
    if (!r.ok) return res.status(r.status).json({ error: 'EDGAR returned ' + r.status });

    const data = await r.json();
    const hits  = data?.hits?.hits || [];
    console.log('EDGAR hits:', hits.length);

    // Also fetch the most recent insider trades from known large-cap CIKs
    // NVDA CIK = 1045810
    const topCIKs = [
      { cik: '1045810', ticker: 'NVDA', company: 'NVIDIA' },
      { cik: '0000320193', ticker: 'AAPL', company: 'Apple' },
      { cik: '0000789019', ticker: 'MSFT', company: 'Microsoft' },
      { cik: '0001326801', ticker: 'META', company: 'Meta' },
      { cik: '0001318605', ticker: 'TSLA', company: 'Tesla' },
      { cik: '0000034088', ticker: 'XOM',  company: 'ExxonMobil' },
      { cik: '0000040987', ticker: 'GS',   company: 'Goldman Sachs' },
      { cik: '0000101830', ticker: 'RTX',  company: 'RTX Corp' },
      { cik: '0000936395', ticker: 'LMT',  company: 'Lockheed Martin' },
    ];

    const tradePromises = topCIKs.map(async ({ cik, ticker, company }) => {
      try {
        const url = `https://data.sec.gov/submissions/CIK${cik.padStart(10,'0')}.json`;
        const r2  = await fetch(url, {
          headers: { 'User-Agent': 'TheRotation newsletter@therotation.com' },
          timeout: 8000,
        });
        if (!r2.ok) return [];
        const sub = await r2.json();

        // Get recent Form 4 filings
        const filings = sub?.filings?.recent || {};
        const forms   = filings.form || [];
        const dates   = filings.filingDate || [];
        const accNums = filings.accessionNumber || [];

        const trades = [];
        const cutoff = Date.now() - 30 * 86400 * 1000;

        forms.forEach((form, i) => {
          if (form !== '4') return;
          if (new Date(dates[i]).getTime() < cutoff) return;
          trades.push({
            date:    dates[i],
            ticker:  ticker,
            company: company,
            name:    'See filing',
            role:    'Insider',
            type:    'See filing',
            value:   0,
            filingUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=5`,
          });
        });
        return trades.slice(0, 3);
      } catch(e) {
        return [];
      }
    });

    const allTrades = (await Promise.all(tradePromises)).flat();
    console.log('Total insider filings found:', allTrades.length);

    // Cluster by ticker
    const byTicker = {};
    allTrades.forEach(t => {
      if (!byTicker[t.ticker]) byTicker[t.ticker] = {
        ticker: t.ticker, company: t.company, buys: [], sells: [], filings: []
      };
      byTicker[t.ticker].filings.push(t);
    });

    const clustered = Object.values(byTicker)
      .filter(g => g.filings.length > 0)
      .sort((a, b) => b.filings.length - a.filings.length);

    if (allTrades.length === 0) {
      return res.status(404).json({ error: 'No recent Form 4 filings found' });
    }

    res.json({
      success:   true,
      count:     allTrades.length,
      source:    'SEC EDGAR — Form 4 Filings',
      note:      'Form 4 mandatory within 2 business days of trade',
      trades:    allTrades,
      clustered: clustered,
    });

  } catch(err) {
    console.error('Insiders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('The Rotation proxy running on port ' + PORT));
