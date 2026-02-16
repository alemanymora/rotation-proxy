const express = require('express');
const fetch   = require('node-fetch');
const app     = express();
const PORT    = process.env.PORT || 3000;

// CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.json({ status:'ok', service:'The Rotation Data Proxy', endpoints:['/congress','/insiders','/debug-xml','/debug-ptr'] });
});

function stripHtml(s) {
  return (s||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();
}

app.get('/debug-xml', async (req, res) => {
  try {
    const r = await fetch('https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0 TheRotation/1.0' }, timeout: 20000,
    });
    const xml  = await r.text();
    const first = (xml.match(/<Member>([\s\S]*?)<\/Member>/i) || ['',''])[0];
    res.json({ totalLength: xml.length, memberCount: (xml.match(/<Member>/gi)||[]).length, firstMember: first });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-ptr', async (req, res) => {
  try {
    const url = 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20033981.xml';
    const r   = await fetch(url, { headers:{'User-Agent':'Mozilla/5.0 TheRotation/1.0'}, timeout:10000 });
    const text = await r.text();
    res.json({
      status: r.status, ok: r.ok,
      contentType: r.headers.get('content-type'),
      length: text.length,
      preview: text.slice(0, 1000),
      hasTransaction: text.includes('<Transaction>'),
      hasPtrTxn: text.includes('<ptr-txn>'),
      allTags: [...new Set((text.match(/<[A-Za-z][A-Za-z0-9_-]*>/g)||[]))].slice(0,40),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/congress', async (req, res) => {
  try {
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
      if (filings.length >= 25) break;
    }
    if (filings.length === 0) return res.status(404).json({ error:'No PTR filings found' });
    const trades = [];
    await Promise.all(filings.slice(0,20).map(async filing => {
      const fallback = { Representative:filing.name, Party:'?', Chamber:'House', State:filing.state, Ticker:'?', Company:'See filing', Amount:'See filing', Date:filing.date, Filed:filing.date, Transaction:'Purchase/Sale', Committee:'', FilingUrl:`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filing.year}/${filing.docId}.pdf` };
      if (!filing.docId) { trades.push(fallback); return; }
      try {
        const r = await fetch(`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filing.year}/${filing.docId}.xml`, {
          headers:{'User-Agent':'Mozilla/5.0 TheRotation/1.0'}, timeout:8000
        });
        if (!r.ok) { trades.push(fallback); return; }
        const xml = await r.text();
        const txnBlocks = xml.match(/<Transaction>([\s\S]*?)<\/Transaction>/gi) ||
                          xml.match(/<ptr-txn>([\s\S]*?)<\/ptr-txn>/gi) ||
                          xml.match(/<NewHoldingLine>([\s\S]*?)<\/NewHoldingLine>/gi) || [];
        if (txnBlocks.length === 0) { trades.push(fallback); return; }
        txnBlocks.forEach(txn => {
          const get = tag => { const x = txn.match(new RegExp('<'+tag+'[^>]*>([^<]*)</'+tag+'>', 'i')); return x ? stripHtml(x[1]) : ''; };
          trades.push({ Representative:filing.name, Party:'?', Chamber:'House', State:filing.state, Ticker:(get('ticker')||get('Ticker')||get('AssetCode')||'?').replace(/\$/g,'').trim(), Company:get('AssetDescription')||'?', Amount:get('amount')||get('Amount')||'Undisclosed', Date:filing.date, Filed:filing.date, Transaction:(get('type')||get('Type')||'').toLowerCase().includes('purchase')?'Purchase':'Sale', Committee:'', FilingUrl:`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${filing.year}/${filing.docId}.pdf` });
        });
      } catch(e) { trades.push(fallback); }
    }));
    trades.sort((a,b) => new Date(b.Date) - new Date(a.Date));
    res.json({ success:true, count:trades.length, source:'US House PTR Filings', trades:trades.slice(0,80) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/insiders', async (req, res) => {
  try {
    const CIKS = [
      {cik:'1045810',ticker:'NVDA',company:'NVIDIA'},{cik:'320193',ticker:'AAPL',company:'Apple'},
      {cik:'789019',ticker:'MSFT',company:'Microsoft'},{cik:'1326801',ticker:'META',company:'Meta'},
      {cik:'1318605',ticker:'TSLA',company:'Tesla'},{cik:'34088',ticker:'XOM',company:'ExxonMobil'},
      {cik:'40987',ticker:'GS',company:'Goldman Sachs'},{cik:'936395',ticker:'LMT',company:'Lockheed Martin'},
      {cik:'101830',ticker:'RTX',company:'RTX Corp'},{cik:'1108524',ticker:'AMZN',company:'Amazon'},
      {cik:'1652044',ticker:'GOOGL',company:'Alphabet'},{cik:'773840',ticker:'AMD',company:'AMD'},
      {cik:'19617',ticker:'JPM',company:'JPMorgan'},
    ];
    const cutoff = Date.now() - 30 * 86400 * 1000;
    const allTrades = [];
    await Promise.all(CIKS.map(async ({cik, ticker, company}) => {
      try {
        const r = await fetch(`https://data.sec.gov/submissions/CIK${cik.padStart(10,'0')}.json`, {
          headers:{'User-Agent':'TheRotation newsletter@therotation.com'}, timeout:8000
        });
        if (!r.ok) return;
        const sub = await r.json();
        const rec = sub?.filings?.recent || {};
        const forms = rec.form || [], dates = rec.filingDate || [], accNs = rec.accessionNumber || [];
        const recent = [];
        forms.forEach((f,i) => { if (f !== '4') return; if (new Date(dates[i]).getTime() < cutoff) return; recent.push({date:dates[i], acc:accNs[i]}); });
        await Promise.all(recent.slice(0,3).map(async ({date, acc}) => {
          try {
            const folder = acc.replace(/-/g,''), cikInt = parseInt(cik);
            const idxR = await fetch(`https://www.sec.gov/Archives/edgar/data/${cikInt}/${folder}/${acc}-index.json`, { headers:{'User-Agent':'TheRotation newsletter@therotation.com'}, timeout:6000 });
            let xmlFile = acc + '.xml';
            if (idxR.ok) { const idx = await idxR.json(); const files = idx.directory?.item || []; const found = files.find(f => f.name && f.name.endsWith('.xml') && !f.name.includes('index')); if (found) xmlFile = found.name; }
            const r2 = await fetch(`https://www.sec.gov/Archives/edgar/data/${cikInt}/${folder}/${xmlFile}`, { headers:{'User-Agent':'TheRotation newsletter@therotation.com'}, timeout:6000 });
            if (!r2.ok) return;
            const xml = await r2.text();
            const getTag = tag => { const m = xml.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)</'+tag+'>', 'i')); return m ? stripHtml(m[1]) : ''; };
            const name = getTag('rptOwnerName') || 'Unknown';
            const role = getTag('officerTitle') || (xml.includes('<isDirector>1') ? 'Director' : 'Insider');
            const txns = xml.match(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi) || [];
            txns.forEach(txn => {
              const getB = tag => { const m = txn.match(new RegExp('<'+tag+'[^>]*>([^<]*)</'+tag+'>', 'i')); return m ? m[1].trim() : ''; };
              const code = getB('transactionCode'), shares = parseFloat(getB('transactionShares')||'0'), price = parseFloat(getB('transactionPricePerShare')||'0'), value = shares * price;
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
    allTrades.forEach(t => { if (!byTicker[t.ticker]) byTicker[t.ticker] = {ticker:t.ticker,company:t.company,buys:[],sells:[]}; if (t.type==='Purchase') byTicker[t.ticker].buys.push(t); else byTicker[t.ticker].sells.push(t); });
    const clustered = Object.values(byTicker).filter(g => g.buys.length+g.sells.length > 0).sort((a,b) => (b.buys.length+b.sells.length)-(a.buys.length+a.sells.length));
    res.json({success:true, count:allTrades.length, source:'SEC EDGAR Form 4', trades:allTrades, clustered});
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.listen(PORT, () => console.log('The Rotation proxy running on port ' + PORT));
