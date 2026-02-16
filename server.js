const express  = require('express');
const fetch    = require('node-fetch');
const pdfParse = require('pdf-parse');
const app      = express();
const PORT     = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.json({ status:'ok', service:'The Rotation Data Proxy', endpoints:['/congress','/insiders'] });
});

function stripHtml(s) {
  return (s||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();
}

// ── PARSE TICKERS FROM PTR PDF TEXT ──────────────────────────
// House PTR PDFs have a consistent table format:
// Asset | Transaction Type | Date | Amount | Cap Gains
// Tickers appear as $ prefix or in parens like (NVDA)
function parseTradesFromPdfText(text, representative) {
  const trades = [];
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Pattern 1: ticker with $ prefix e.g. "$NVDA" or "NVDA (NVIDIA)"
  // Pattern 2: lines with P/S transaction codes and dollar amounts
  // Pattern 3: asset description lines followed by transaction type lines

  let currentAsset  = '';
  let currentTicker = '';

  const tickerPattern = /\b([A-Z]{1,5})\b/g;
  const amountPattern = /\$[\d,]+(?:\s*-\s*\$[\d,]+)?/g;
  const txTypePattern = /\b(Purchase|Sale|P|S)\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip header/footer lines
    if (line.includes('Page ') || line.includes('STOCK ACT') ||
        line.includes('U.S. House') || line.includes('Clerk of')) continue;

    // Look for ticker symbols — they appear in asset description
    // Common pattern: "Apple Inc. (AAPL)" or "NVDA" standalone
    const tickerMatch = line.match(/\(([A-Z]{1,5})\)/) ||
                        line.match(/^([A-Z]{1,5})\s*$/) ||
                        line.match(/\$([A-Z]{1,5})\b/);

    if (tickerMatch) {
      currentTicker = tickerMatch[1];
      currentAsset  = line;
    }

    // Look for transaction lines — contain P or S and a dollar amount
    const hasTxType = txTypePattern.test(line);
    const amounts   = line.match(amountPattern) || [];

    if (hasTxType && amounts.length > 0 && (currentTicker || currentAsset)) {
      const txMatch = line.match(/\b(Purchase|Sale|P|S)\b/i);
      const txType  = txMatch ? txMatch[1] : '';
      const type    = txType.toLowerCase().startsWith('p') ? 'Purchase' : 'Sale';

      // Get amount range
      const amount = amounts[0] || 'Undisclosed';

      if (currentTicker && currentTicker.length >= 1 && currentTicker.length <= 5) {
        trades.push({ ticker: currentTicker, asset: currentAsset, type, amount });
      }
    }
  }

  // Deduplicate by ticker+type
  const seen = new Set();
  return trades.filter(t => {
    const key = t.ticker + t.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── CONGRESSIONAL TRADES ──────────────────────────────────────
app.get('/congress', async (req, res) => {
  try {
    // Step 1: Get all PTR filings from House XML
    const filings = [];
    for (const year of [2026, 2025]) {
      const r = await fetch(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`, {
        headers: { 'User-Agent': 'Mozilla/5.0 TheRotation/1.0' }, timeout: 20000,
      });
      if (!r.ok) continue;
      const xml     = await r.text();
      const members = xml.match(/<Member>([\s\S]*?)<\/Member>/gi) || [];
      const cutoff  = Date.now() - 90 * 86400 * 1000;

      members.forEach(m => {
        const get = tag => { const x = m.match(new RegExp('<'+tag+'[^>]*>([^<]*)</'+tag+'>', 'i')); return x ? x[1].trim() : ''; };
        if (get('FilingType') !== 'P') return;
        const rawDate = get('FilingDate') || '';
        let date = rawDate;
        if (rawDate.includes('/')) {
          const p = rawDate.split('/');
          if (p.length === 3) date = p[2]+'-'+p[0].padStart(2,'0')+'-'+p[1].padStart(2,'0');
        }
        if (date && new Date(date).getTime() < cutoff) return;
        filings.push({ name:(get('First')+' '+get('Last')).trim(), state:get('StateDst')||'?', date, docId:get('DocID'), year });
      });
      if (filings.length >= 60) break;
    }

    console.log('Total PTR filings found:', filings.length);
    if (filings.length === 0) return res.status(404).json({ error:'No PTR filings found' });

    // Step 2: Fetch and parse each PDF
    const allTrades = [];
    const filingsMeta = [];

    // Process in batches of 10 to avoid timeout
    const batch = filings.slice(0, 40);

    await Promise.all(batch.map(async filing => {
      const pdfUrl = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filing.year}/${filing.docId}.pdf`;

      try {
        const r = await fetch(pdfUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 TheRotation/1.0' },
          timeout: 12000,
        });
        if (!r.ok) {
          // Add filing metadata even without PDF parse
          filingsMeta.push({ Representative:filing.name, Party:'?', Chamber:'House', State:filing.state, Ticker:'?', Company:'See filing', Amount:'See filing', Date:filing.date, Filed:filing.date, Transaction:'Purchase/Sale', Committee:'', FilingUrl:pdfUrl });
          return;
        }

        const buffer = await r.buffer();
        const pdf    = await pdfParse(buffer);
        const text   = pdf.text;

        console.log(`Parsed PDF for ${filing.name}: ${text.length} chars`);

        const trades = parseTradesFromPdfText(text, filing.name);
        console.log(`  → ${trades.length} trades found`);

        if (trades.length === 0) {
          // No trades parsed — add filing metadata as fallback
          filingsMeta.push({ Representative:filing.name, Party:'?', Chamber:'House', State:filing.state, Ticker:'?', Company:'See filing', Amount:'See filing', Date:filing.date, Filed:filing.date, Transaction:'Purchase/Sale', Committee:'', FilingUrl:pdfUrl });
          return;
        }

        trades.forEach(t => {
          allTrades.push({
            Representative: filing.name,
            Party:          '?',
            Chamber:        'House',
            State:          filing.state,
            Ticker:         t.ticker,
            Company:        t.asset || '?',
            Amount:         t.amount,
            Date:           filing.date,
            Filed:          filing.date,
            Transaction:    t.type,
            Committee:      '',
            FilingUrl:      pdfUrl,
          });
        });

      } catch(e) {
        console.log('PDF error for', filing.name, ':', e.message);
        filingsMeta.push({ Representative:filing.name, Party:'?', Chamber:'House', State:filing.state, Ticker:'?', Company:'See filing', Amount:'See filing', Date:filing.date, Filed:filing.date, Transaction:'Purchase/Sale', Committee:'', FilingUrl:pdfUrl });
      }
    }));

    // Combine parsed trades + fallback metadata
    const combined = [...allTrades, ...filingsMeta];
    combined.sort((a,b) => new Date(b.Date) - new Date(a.Date));

    console.log('Total trades returned:', combined.length, '(', allTrades.length, 'with tickers,', filingsMeta.length, 'fallback)');

    res.json({
      success:    true,
      count:      combined.length,
      withTickers: allTrades.length,
      source:     'US House PTR Filings (PDF parsed)',
      trades:     combined.slice(0, 100),
    });

  } catch(err) {
    console.error('Congress error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── INSIDER TRADES (SEC EDGAR Form 4) ────────────────────────
app.get('/insiders', async (req, res) => {
  try {
    const CIKS = [
      {cik:'1045810',ticker:'NVDA',company:'NVIDIA'},
      {cik:'320193', ticker:'AAPL',company:'Apple'},
      {cik:'789019', ticker:'MSFT',company:'Microsoft'},
      {cik:'1326801',ticker:'META',company:'Meta'},
      {cik:'1318605',ticker:'TSLA',company:'Tesla'},
      {cik:'34088',  ticker:'XOM', company:'ExxonMobil'},
      {cik:'40987',  ticker:'GS',  company:'Goldman Sachs'},
      {cik:'936395', ticker:'LMT', company:'Lockheed Martin'},
      {cik:'101830', ticker:'RTX', company:'RTX Corp'},
      {cik:'1108524',ticker:'AMZN',company:'Amazon'},
      {cik:'1652044',ticker:'GOOGL',company:'Alphabet'},
      {cik:'773840', ticker:'AMD', company:'AMD'},
      {cik:'19617',  ticker:'JPM', company:'JPMorgan'},
    ];
    const cutoff    = Date.now() - 30 * 86400 * 1000;
    const allTrades = [];

    await Promise.all(CIKS.map(async ({cik, ticker, company}) => {
      try {
        const r = await fetch(`https://data.sec.gov/submissions/CIK${cik.padStart(10,'0')}.json`, {
          headers:{'User-Agent':'TheRotation newsletter@therotation.com'}, timeout:8000
        });
        if (!r.ok) return;
        const sub   = await r.json();
        const rec   = sub?.filings?.recent || {};
        const forms = rec.form || [], dates = rec.filingDate || [], accNs = rec.accessionNumber || [];
        const recent = [];
        forms.forEach((f,i) => {
          if (f !== '4') return;
          if (new Date(dates[i]).getTime() < cutoff) return;
          recent.push({date:dates[i], acc:accNs[i]});
        });

        await Promise.all(recent.slice(0,3).map(async ({date, acc}) => {
          try {
            const folder = acc.replace(/-/g,''), cikInt = parseInt(cik);
            const idxR = await fetch(`https://www.sec.gov/Archives/edgar/data/${cikInt}/${folder}/${acc}-index.json`, {
              headers:{'User-Agent':'TheRotation newsletter@therotation.com'}, timeout:6000
            });
            let xmlFile = acc + '.xml';
            if (idxR.ok) {
              const idx   = await idxR.json();
              const files = idx.directory?.item || [];
              const found = files.find(f => f.name && f.name.endsWith('.xml') && !f.name.includes('index'));
              if (found) xmlFile = found.name;
            }
            const r2 = await fetch(`https://www.sec.gov/Archives/edgar/data/${cikInt}/${folder}/${xmlFile}`, {
              headers:{'User-Agent':'TheRotation newsletter@therotation.com'}, timeout:6000
            });
            if (!r2.ok) return;
            const xml    = await r2.text();
            const getTag = tag => { const m = xml.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)</'+tag+'>', 'i')); return m ? stripHtml(m[1]) : ''; };
            const name   = getTag('rptOwnerName') || 'Unknown';
            const role   = getTag('officerTitle') || (xml.includes('<isDirector>1') ? 'Director' : 'Insider');
            const txns   = xml.match(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi) || [];
            txns.forEach(txn => {
              const getB   = tag => { const m = txn.match(new RegExp('<'+tag+'[^>]*>([^<]*)</'+tag+'>', 'i')); return m ? m[1].trim() : ''; };
              const code   = getB('transactionCode');
              const shares = parseFloat(getB('transactionShares')||'0');
              const price  = parseFloat(getB('transactionPricePerShare')||'0');
              const value  = shares * price;
              if (value < 10000) return;
              const type = code==='P'?'Purchase':code==='S'?'Sale':null;
              if (!type) return;
              allTrades.push({date,ticker,company,name,role,type,shares:Math.round(shares),price,value:Math.round(value)});
            });
          } catch(e) {}
        }));
      } catch(e) { console.log('CIK error',cik,e.message); }
    }));

    const byTicker = {};
    allTrades.forEach(t => {
      if (!byTicker[t.ticker]) byTicker[t.ticker] = {ticker:t.ticker,company:t.company,buys:[],sells:[]};
      if (t.type==='Purchase') byTicker[t.ticker].buys.push(t);
      else byTicker[t.ticker].sells.push(t);
    });
    const clustered = Object.values(byTicker)
      .filter(g => g.buys.length+g.sells.length > 0)
      .sort((a,b) => (b.buys.length+b.sells.length)-(a.buys.length+a.sells.length));

    res.json({success:true, count:allTrades.length, source:'SEC EDGAR Form 4', trades:allTrades, clustered});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.listen(PORT, () => console.log('The Rotation proxy running on port ' + PORT));
