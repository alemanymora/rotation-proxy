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
// Source: Official House of Representatives financial disclosure API
// https://disclosures-clerk.house.gov — official US government site
app.get('/congress', async (req, res) => {
  try {
    const results = [];
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;

    // The House publishes official XML data files by year
    // This is the actual government disclosure system
    for (const year of [currentYear, lastYear]) {
      try {
        const xmlUrl = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`;
        console.log('Fetching House XML:', xmlUrl);

        const response = await fetch(xmlUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TheRotation newsletter bot)',
            'Accept': 'application/xml, text/xml, */*',
          },
          timeout: 20000,
        });

        console.log('House XML status:', response.status);
        if (!response.ok) continue;

        const xml = await response.text();
        console.log('House XML length:', xml.length);

        // Parse XML — extract periodic transaction reports (PTR) which are the trade disclosures
        const memberMatches = xml.match(/<Member>([\s\S]*?)<\/Member>/gi) || [];
        console.log('House members found:', memberMatches.length);

        const cutoff = Date.now() - 90 * 86400 * 1000;

        memberMatches.slice(0, 200).forEach(member => {
          const get = tag => {
            const m = member.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>', 'i'));
            return m ? m[1].trim() : '';
          };

          const name    = get('Name') || (get('First') + ' ' + get('Last'));
          const docType = get('DocType') || '';
          const filedDate = get('FilingDate') || get('Year') || '';

          // Only PTR = Periodic Transaction Report = actual trades
          if (!docType.toUpperCase().includes('PTR') &&
              !docType.toUpperCase().includes('TRANSACTION')) return;

          if (filedDate && new Date(filedDate).getTime() < cutoff) return;

          results.push({
            Representative: name,
            Party:          '?',
            Chamber:        'House',
            State:          get('StateDst') || '?',
            Ticker:         '?',
            Company:        'See filing',
            Amount:         'Undisclosed',
            Date:           filedDate,
            Filed:          filedDate,
            Transaction:    'Purchase',
            Committee:      '',
            FilingUrl:      `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${get('DocID')}.pdf`,
          });
        });

        console.log('House results after year', year, ':', results.length);
        if (results.length > 10) break; // got enough

      } catch(e) {
        console.log('House XML error:', e.message);
      }
    }

    // ── Senate STOCK Act API ──────────────────────────────────
    // Senate publishes an electronic filing search API
    try {
      const senateUrl = 'https://efts.sec.gov/LATEST/search-index?q=%22periodic+transaction%22&dateRange=custom&startdt=' +
        new Date(Date.now() - 60*86400*1000).toISOString().slice(0,10) +
        '&enddt=' + new Date().toISOString().slice(0,10);

      // Actually use the Senate eFD search
      const senateEFD = 'https://efts.senate.gov/LATEST/search-index?q=%22stock%22&dateRange=custom' +
        '&startdt=' + new Date(Date.now() - 60*86400*1000).toISOString().slice(0,10) +
        '&enddt=' + new Date().toISOString().slice(0,10);

      console.log('Trying Senate EFD...');
      const sRes = await fetch(senateEFD, {
        headers: { 'User-Agent': 'TheRotation/1.0' },
        timeout: 10000,
      });
      console.log('Senate EFD status:', sRes.status);

    } catch(e) {
      console.log('Senate EFD error:', e.message);
    }

    // ── Fallback: Use quiverquant public endpoints ─────────────
    if (results.length === 0) {
      try {
        // Quiver has some public pages that return JSON
        const qRes = await fetch('https://www.quiverquant.com/sources/congresstrading', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          timeout: 10000,
        });
        console.log('Quiver status:', qRes.status);
        if (qRes.ok) {
          const data = await qRes.json();
          console.log('Quiver data type:', typeof data, Array.isArray(data) ? data.length : 'not array');
        }
      } catch(e) {
        console.log('Quiver error:', e.message);
      }
    }

    // ── Last resort: Unusual Whales Congress API ──────────────
    if (results.length === 0) {
      try {
        const uwRes = await fetch('https://api.unusualwhales.com/api/congress/trades?limit=50', {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
          },
          timeout: 10000,
        });
        console.log('Unusual Whales status:', uwRes.status);
        if (uwRes.ok) {
          const data = await uwRes.json();
          const trades = data?.data || data?.trades || data || [];
          console.log('UW trades:', Array.isArray(trades) ? trades.length : 'not array');
          if (Array.isArray(trades) && trades.length > 0) {
            trades.slice(0, 60).forEach(t => {
              results.push({
                Representative: t.representative || t.politician_name || t.name || 'Unknown',
                Party:          t.party || '?',
                Chamber:        t.chamber || '?',
                Ticker:         t.ticker || t.symbol || '?',
                Company:        t.issuer_name || t.company || '?',
                Amount:         t.amount || t.trade_size || 'Undisclosed',
                Date:           t.traded_at || t.transaction_date || t.date || '',
                Filed:          t.filed_at || t.disclosure_date || '',
                Transaction:    (t.type || t.transaction_type || '').toLowerCase().includes('buy') ||
                                (t.type || '').toLowerCase().includes('purchase') ? 'Purchase' : 'Sale',
                Committee:      '',
              });
            });
          }
        }
      } catch(e) {
        console.log('Unusual Whales error:', e.message);
      }
    }

    if (results.length === 0) {
      return res.status(404).json({
        error: 'No congressional trade data available',
        tried: ['House Disclosures XML', 'Senate EFD', 'Quiver Quant', 'Unusual Whales'],
        note: 'All sources failed — check Render logs for details'
      });
    }

    results.sort((a, b) => new Date(b.Date) - new Date(a.Date));

    res.json({
      success: true,
      count:   results.length,
      source:  'US House Financial Disclosures',
      trades:  results.slice(0, 80),
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

    const tableMatch = html.match(/<table[^>]*class="[^"]*tinytable[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) {
      return res.status(500).json({ error: 'Could not find insider trades table', htmlLength: html.length });
    }

    const rows   = tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    const trades = [];

    rows.forEach((row, idx) => {
      if (idx === 0) return;
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c =>
        strip(c.replace(/<td[^>]*>/i, '').replace(/<\/td>/i, ''))
      );
      if (cells.length < 10) return;
      const value = parseFloat((cells[11] || cells[10] || '0').replace(/[$,+]/g, '')) * 1000;
      if (value < 50000) return;
      trades.push({
        date:    cells[1] || '',
        ticker:  cells[3] || '',
        company: cells[4] || '',
        name:    cells[5] || '',
        role:    cells[6] || '',
        type:    (cells[7] || '').startsWith('P') ? 'Purchase' : 'Sale',
        price:   parseFloat((cells[8]  || '0').replace(/[$,]/g, '')),
        shares:  parseInt((cells[9]   || '0').replace(/[+,]/g, '')) || 0,
        value:   value,
      });
    });

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
