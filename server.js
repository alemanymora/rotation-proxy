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

  // The House PTR PDF format has rows like:
  // SP  Alphabet Inc. - Class A Common Stock (GOOGL) [ST]  P  01/16/2026  01/16/2026  $500,001 - $1,000,000
  // We need to find lines with a ticker in parens AND a transaction type AND an amount

  const amountPattern = /\$[\d,]+(?:\s*-\s*\$[\d,]+)?/;
  
  // Strategy 1: Find lines containing (TICKER) pattern with amount on same or adjacent line
  let currentAsset  = '';
  let currentTicker = '';
  let currentType   = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i+1] || '';
    const combined = line + ' ' + next;

    // Skip noise lines
    if (line.length < 3) continue;
    if (/^(ID|Owner|Asset|Transaction|Date|Notification|Amount|Cap\.|Page|Filing|Clerk|PERIODIC|Hon\.|Name:|Status:|State)/.test(line)) continue;

    // Find ticker in parens — most reliable pattern in House PDFs
    const tickerMatch = line.match(/\(([A-Z]{1,5})\)/) || 
                        line.match(/\[([A-Z]{1,5})\](?!ST|OT|AB|OP|MF)/);
    
    if (tickerMatch) {
      currentTicker = tickerMatch[1];
      currentAsset  = line;
    }

    // Find transaction type — standalone P or S, or full word
    // Look in current line and next few lines
    const searchText = lines.slice(i, i+4).join(' ');
    const txMatch    = searchText.match(/\b(Purchase|Sale)\b/i) ||
                       line.match(/^\s*([PS])\s+\d/) ||  // P 01/16/2026
                       line.match(/\s([PS])\s+\d{2}\/\d{2}/);  // SP ... P 01/16

    if (txMatch && currentTicker) {
      const txWord = txMatch[1].toUpperCase();
      currentType  = (txWord === 'P' || txWord.startsWith('P')) ? 'Purchase' : 'Sale';
    }

    // Find amount
    const amountMatch = combined.match(amountPattern);
    
    if (currentTicker && currentType && amountMatch) {
      trades.push({
        ticker: currentTicker,
        asset:  currentAsset,
        type:   currentType,
        amount: amountMatch[0],
      });
      // Only reset type/amount — keep ticker in case same stock traded again
      currentType   = '';
    }
  }

  // Strategy 2: Scan entire text for pattern blocks
  // Pattern: ticker in parens followed within 200 chars by P or S and a dollar amount
  const fullText = text.replace(/\n/g, ' ');
  const blockPattern = /\(([A-Z]{1,5})\)[^$]{0,300}?\b(Purchase|Sale|[PS])\b[^$]{0,100}?(\$[\d,]+(?:\s*-\s*\$[\d,]+)?)/gi;
  let match;
  while ((match = blockPattern.exec(fullText)) !== null) {
    const ticker = match[1];
    const txWord = match[2].toUpperCase();
    const type   = (txWord === 'P' || txWord === 'PURCHASE') ? 'Purchase' : 'Sale';
    const amount = match[3];
    // Skip common false positives
    if (['ST', 'OT', 'OP', 'MF', 'DC', 'SP', 'JT', 'TR', 'IRA', 'JA', 'DEP'].includes(ticker)) continue;
    trades.push({ ticker, asset: '', type, amount });
  }

  // Deduplicate by ticker+type+amount, keeping first occurrence
  const seen = new Set();
  return trades.filter(t => {
    if (!t.ticker || t.ticker.length < 1 || t.ticker.length > 5) return false;
    const key = t.ticker + t.type + t.amount;
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
        console.log('PDF error for', filing.name, filing.docId, ':', e.message);
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
