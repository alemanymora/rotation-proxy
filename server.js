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

// ── HELPERS ───────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&')
    .replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/&gt;/g,'>').replace(/&lt;/g,'<').trim();
}

// ── CONGRESSIONAL TRADES ──────────────────────────────────────
// Step 1: Get filing list from House XML
// Step 2: Fetch each PTR XML to get actual trade details
app.get('/congress', async (req, res) => {
  try {
    const filings = [];

    // Get filing index
    for (const year of [2026, 2025]) {
      const url = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 TheRotation/1.0' },
        timeout: 20000,
      });
      if (!r.ok) continue;
      const xml = await r.text();
      const members = xml.match(/<Member>([\s\S]*?)<\/Member>/gi) || [];
      const cutoff  = Date.now() - 90 * 86400 * 1000;

      members.forEach(m => {
        const get = tag => { const x = m.match(new RegExp('<'+tag+'>([^<]*)</'+tag+'>', 'i')); return x ? x[1].trim() : ''; };
        if (get('FilingType') !== 'P') return;
        const date = get('FilingDate') || year + '-01-01';
        if (new Date(date).getTime() < cutoff) return;
        filings.push({
          name:  get('First') + ' ' + get('Last'),
          state: get('StateDst'),
          date,
          docId: get('DocID'),
          year,
        });
      });
      if (filings.length >= 30) break;
    }

    console.log('Filings to parse:', filings.length);

    // Step 2: Fetch individual PTR XML files to get trade details
    // House PTR XML format: /public_disc/ptr-pdfs/YEAR/DOCID.xml (not .pdf!)
    const trades = [];
    const toFetch = filings.slice(0, 20); // limit to 20 to avoid timeout

    await Promise.all(toFetch.map(async filing => {
      try {
        const xmlUrl = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filing.year}/${filing.docId}.xml`;
        const r = await fetch(xmlUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 TheRotation/1.0' },
          timeout: 8000,
        });
        if (!r.ok) return;
        const xml = await r.text();

        // Parse individual transactions in the PTR
        const txns = xml.match(/<Transaction>([\s\S]*?)<\/Transaction>/gi) ||
                     xml.match(/<ptr-txn>([\s\S]*?)<\/ptr-txn>/gi) || [];

        if (txns.length === 0) {
          // Try alternate XML structure
          const assets = xml.match(/<\/New>([\s\S]*?)<New>/gi) ||
                         xml.match(/<Asset>([\s\S]*?)<\/Asset>/gi) || [];

          // Fallback: just record the filing with no ticker
          trades.push({
            Representative: filing.name,
            Party: '?',
            Chamber: 'House',
            State: filing.state,
            Ticker: '?',
            Company: 'Multiple — see filing',
            Amount: 'See filing',
            Date: filing.date,
            Filed: filing.date,
            Transaction: 'Purchase/Sale',
            Committee: '',
            FilingUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filing.year}/${filing.docId}.pdf`,
          });
          return;
        }

        txns.forEach(txn => {
          const get = tag => { const x = txn.match(new RegExp('<'+tag+'[^>]*>([^<]*)</'+tag+'>', 'i')); return x ? stripHtml(x[1]) : ''; };
          const ticker = get('ticker') || get('Ticker') || get('AssetCode') || '?';
          const txType = get('type') || get('Type') || get('TransactionType') || '';
          const amount = get('amount') || get('Amount') || get('TransactionAmount') || 'Undisclosed';

          trades.push({
            Representative: filing.name,
            Party: '?',
            Chamber: 'House',
            State: filing.state,
            Ticker: ticker.replace(/\$/g,'').trim() || '?',
            Company: get('AssetDescription') || get('asset_description') || '?',
            Amount: amount,
            Date: filing.date,
            Filed: filing.date,
            Transaction: txType.toLowerCase().includes('purchase') || txType === 'P' ? 'Purchase' : 'Sale',
            Committee: '',
            FilingUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filing.year}/${filing.docId}.pdf`,
          });
        });
      } catch(e) {
        // Fallback filing entry
        trades.push({
          Representative: filing.name,
          Party: '?', Chamber: 'House', State: filing.state,
          Ticker: '?', Company: 'See filing', Amount: 'See filing',
          Date: filing.date, Filed: filing.date, Transaction: 'Purchase/Sale',
          Committee: '',
          FilingUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filing.year}/${filing.docId}.pdf`,
        });
      }
    }));

    trades.sort((a,b) => new Date(b.Date) - new Date(a.Date));
    console.log('Total trades parsed:', trades.length);

    res.json({
      success: true,
      count: trades.length,
      source: 'US House of Representatives — Official PTR Filings',
      trades: trades.slice(0, 80),
    });

  } catch(err) {
    console.error('Congress error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── INSIDER TRADES (SEC EDGAR Form 4 XML) ────────────────────
// Step 1: Get recent Form 4 filings for key tickers
// Step 2: Fetch individual Form 4 XML to get insider name, role, shares, price
app.get('/insiders', async (req, res) => {
  try {
    const TOP_CIKS = [
      { cik: '1045810',    ticker: 'NVDA', company: 'NVIDIA' },
      { cik: '320193',     ticker: 'AAPL', company: 'Apple' },
      { cik: '789019',     ticker: 'MSFT', company: 'Microsoft' },
      { cik: '1326801',    ticker: 'META', company: 'Meta' },
      { cik: '1318605',    ticker: 'TSLA', company: 'Tesla' },
      { cik: '34088',      ticker: 'XOM',  company: 'ExxonMobil' },
      { cik: '40987',      ticker: 'GS',   company: 'Goldman Sachs' },
      { cik: '936395',     ticker: 'LMT',  company: 'Lockheed Martin' },
      { cik: '101830',     ticker: 'RTX',  company: 'RTX Corp' },
      { cik: '1108524',    ticker: 'AMZN', company: 'Amazon' },
      { cik: '1652044',    ticker: 'GOOGL', company: 'Alphabet' },
      { cik: '200406',     ticker: 'JNJ',  company: 'Johnson & Johnson' },
      { cik: '19617',      ticker: 'JPM',  company: 'JPMorgan' },
      { cik: '773840',     ticker: 'AMD',  company: 'AMD' },
      { cik: '1341439',    ticker: 'GEV',  company: 'GE Vernova' },
    ];

    const cutoff = Date.now() - 30 * 86400 * 1000;
    const allTrades = [];

    await Promise.all(TOP_CIKS.map(async ({ cik, ticker, company }) => {
      try {
        // Step 1: Get filing list
        const subUrl = `https://data.sec.gov/submissions/CIK${cik.padStart(10,'0')}.json`;
        const r = await fetch(subUrl, {
          headers: { 'User-Agent': 'TheRotation newsletter@therotation.com' },
          timeout: 8000,
        });
        if (!r.ok) return;
        const sub  = await r.json();
        const rec  = sub?.filings?.recent || {};
        const forms = rec.form || [];
        const dates = rec.filingDate || [];
        const accNs = rec.accessionNumber || [];

        // Find recent Form 4s
        const recentF4s = [];
        forms.forEach((form, i) => {
          if (form !== '4') return;
          if (new Date(dates[i]).getTime() < cutoff) return;
          recentF4s.push({ date: dates[i], acc: accNs[i] });
        });

        if (recentF4s.length === 0) return;

        // Step 2: Fetch Form 4 XML for each recent filing
        await Promise.all(recentF4s.slice(0, 3).map(async ({ date, acc }) => {
          try {
            const accFormatted = acc.replace(/-/g, '');
            const accDashed    = acc; // already dashed from EDGAR
            const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accFormatted}/${accDashed}.xml`;
            const r2 = await fetch(xmlUrl, {
              headers: { 'User-Agent': 'TheRotation newsletter@therotation.com' },
              timeout: 6000,
            });

            if (!r2.ok) {
              // Try index to find the actual XML filename
              const idxUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=5&output=atom`;
              allTrades.push({
                date, ticker, company,
                name: 'See filing', role: 'Insider',
                type: 'See filing', value: 0, shares: 0, price: 0,
              });
              return;
            }

            const xml = await r2.text();

            // Parse Form 4 XML
            const getTag = tag => {
              const m = xml.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)</'+tag+'>', 'i'));
              return m ? stripHtml(m[1]) : '';
            };

            const insiderName = getTag('rptOwnerName') || getTag('reportingOwnerName') || 'Unknown';
            const insiderRole = getTag('officerTitle') || getTag('relationship') || 'Insider';
            const isDirector  = xml.includes('<isDirector>1</isDirector>');
            const isOfficer   = xml.includes('<isOfficer>1</isOfficer>');
            const role        = insiderRole || (isOfficer ? 'Officer' : isDirector ? 'Director' : 'Insider');

            // Get all non-derivative transactions
            const txnBlocks = xml.match(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi) || [];

            if (txnBlocks.length === 0) return;

            txnBlocks.forEach(block => {
              const getB = tag => { const m = block.match(new RegExp('<'+tag+'[^>]*>([^<]*)</'+tag+'>', 'i')); return m ? m[1].trim() : ''; };
              const txCode  = getB('transactionCode');
              const shares  = parseFloat(getB('transactionShares') || '0');
              const price   = parseFloat(getB('transactionPricePerShare') || '0');
              const value   = shares * price;

              if (value < 10000) return; // skip tiny transactions

              // P = purchase, S = sale, A = award (skip awards)
              const txType = txCode === 'P' ? 'Purchase' : txCode === 'S' ? 'Sale' : null;
              if (!txType) return;

              allTrades.push({
                date, ticker, company,
                name:   insiderName,
                role:   role,
                type:   txType,
                shares: Math.round(shares),
                price:  price,
                value:  Math.round(value),
              });
            });
          } catch(e) {
            // silent fail for individual filings
          }
        }));
      } catch(e) {
        console.log('CIK error', cik, e.message);
      }
    }));

    // Cluster by ticker
    const byTicker = {};
    allTrades.forEach(t => {
      if (!byTicker[t.ticker]) byTicker[t.ticker] = {
        ticker: t.ticker, company: t.company, buys: [], sells: []
      };
      if (t.type === 'Purchase') byTicker[t.ticker].buys.push(t);
      else if (t.type === 'Sale') byTicker[t.ticker].sells.push(t);
    });

    const clustered = Object.values(byTicker)
      .filter(g => g.buys.length + g.sells.length > 0)
      .sort((a,b) => (b.buys.length + b.sells.length) - (a.buys.length + a.sells.length));

    console.log('Insider trades parsed:', allTrades.length, 'across', clustered.length, 'tickers');

    res.json({
      success: true,
      count: allTrades.length,
      source: 'SEC EDGAR — Form 4 XML',
      trades: allTrades,
      clustered,
    });

  } catch(err) {
    console.error('Insiders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('The Rotation proxy running on port ' + PORT));
