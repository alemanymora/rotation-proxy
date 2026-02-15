const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
require('dotenv').config();

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

app.use(cors());
app.use(express.json());

// Comprehensive RSS Feed Sources - Reliable feeds that don't block bots
const RSS_FEEDS = {
  financial: [
    { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', category: 'financial' },
    { name: 'Investopedia', url: 'https://www.investopedia.com/feedbuilder/feed/getfeed?feedName=rss_headline', category: 'financial' },
    { name: 'WSJ Markets', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', category: 'financial' },
    { name: 'CNBC Top News', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', category: 'financial' },
    { name: 'MarketWatch', url: 'https://www.marketwatch.com/rss/topstories', category: 'financial' },
    { name: 'Fortune', url: 'https://fortune.com/feed', category: 'financial' },
    { name: 'Seeking Alpha Market News', url: 'https://seekingalpha.com/market_currents.xml', category: 'financial' },
    { name: 'Reuters Money', url: 'https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best', category: 'financial' },
    { name: 'Financial Times Markets', url: 'https://www.ft.com/markets?format=rss', category: 'financial' },
    { name: 'TheStreet', url: 'https://www.thestreet.com/feeds/news.xml', category: 'financial' }
  ],
  news: [
    { name: 'New York Times Business', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', category: 'news' },
    { name: 'NPR Business', url: 'https://feeds.npr.org/1006/rss.xml', category: 'news' },
    { name: 'The Guardian Business', url: 'https://www.theguardian.com/business/rss', category: 'news' },
    { name: 'BBC Business', url: 'http://feeds.bbci.co.uk/news/business/rss.xml', category: 'news' },
    { name: 'Reuters Top News', url: 'https://www.reutersagency.com/feed/?best-topics=tech&post_type=best', category: 'news' },
    { name: 'Al Jazeera Economy', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'news' },
    { name: 'CBS News Money', url: 'https://www.cbsnews.com/latest/rss/moneywatch', category: 'news' },
    { name: 'ABC News Business', url: 'https://abcnews.go.com/abcnews/businessheadlines', category: 'news' }
  ],
  tech: [
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'tech' },
    { name: 'Ars Technica', url: 'http://feeds.arstechnica.com/arstechnica/index', category: 'tech' },
    { name: 'Wired', url: 'https://www.wired.com/feed/rss', category: 'tech' },
    { name: 'Engadget', url: 'https://www.engadget.com/rss.xml', category: 'tech' },
    { name: 'The Next Web', url: 'https://thenextweb.com/feed/', category: 'tech' },
    { name: 'ZDNet', url: 'https://www.zdnet.com/news/rss.xml', category: 'tech' },
    { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/', category: 'tech' }
  ],
  crypto: [
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'crypto' },
    { name: 'Decrypt', url: 'https://decrypt.co/feed', category: 'crypto' },
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', category: 'crypto' },
    { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed', category: 'crypto' }
  ],
  venture: [
    { name: 'Crunchbase News', url: 'https://news.crunchbase.com/feed/', category: 'venture' },
    { name: 'VentureBeat', url: 'https://venturebeat.com/feed/', category: 'venture' },
    { name: 'TechCrunch Startups', url: 'https://techcrunch.com/tag/startups/feed/', category: 'venture' }
  ],
  energy: [
    { name: 'Energy News', url: 'https://www.energy-news.com/feed/', category: 'energy' },
    { name: 'Renewable Energy World', url: 'https://www.renewableenergyworld.com/feeds/all/', category: 'energy' }
  ],
  healthcare: [
    { name: 'FiercePharma', url: 'https://www.fiercepharma.com/rss/xml', category: 'healthcare' },
    { name: 'MedCity News', url: 'https://medcitynews.com/feed/', category: 'healthcare' }
  ]
};

// Flatten all feeds
const ALL_FEEDS = Object.values(RSS_FEEDS).flat();

// Cache for parsed feeds
let feedCache = {
  data: [],
  lastUpdated: null
};

// Fetch and parse all RSS feeds
async function fetchAllFeeds() {
  console.log('📡 Fetching feeds from ' + ALL_FEEDS.length + ' sources...');
  
  const results = await Promise.allSettled(
    ALL_FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        return {
          source: feed.name,
          category: feed.category,
          items: parsed.items.slice(0, 20).map(item => ({
            title: item.title,
            link: item.link,
            pubDate: item.pubDate || item.isoDate,
            content: item.contentSnippet || item.content,
            source: feed.name,
            category: feed.category
          }))
        };
      } catch (error) {
        console.error(`❌ Failed to fetch ${feed.name}:`, error.message);
        return null;
      }
    })
  );

  const articles = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .flatMap(r => r.value.items)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  console.log(`✅ Successfully fetched ${articles.length} articles`);
  
  feedCache = {
    data: articles,
    lastUpdated: new Date()
  };

  return articles;
}

// Analyze narratives using Claude
async function analyzeNarratives(articles) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠️  No Anthropic API key - using basic keyword extraction');
    return extractBasicNarratives(articles);
  }

  try {
    const recentArticles = articles.slice(0, 100);
    const articlesText = recentArticles.map(a => 
      `${a.title}\n${a.content?.substring(0, 200) || ''}`
    ).join('\n\n---\n\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Analyze these news headlines and identify the top 5-7 emerging narratives or themes. For each narrative, provide:
1. A clear name/title
2. Key topics involved
3. Momentum (hot/warming/stable)
4. Related industries
5. Potential stock sectors or ETFs

News articles:
${articlesText}

Return ONLY a JSON array with this structure:
[{
  "name": "narrative name",
  "description": "brief description",
  "momentum": "hot|warming|stable",
  "confidence": 0-100,
  "relatedIndustries": ["industry1", "industry2"],
  "keywords": ["keyword1", "keyword2"],
  "stockSectors": ["sector1", "sector2"],
  "etfSymbols": ["symbol1", "symbol2"]
}]`
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return extractBasicNarratives(articles);
  } catch (error) {
    console.error('Error analyzing with AI:', error);
    return extractBasicNarratives(articles);
  }
}

// Fallback: Basic keyword-based narrative extraction
function extractBasicNarratives(articles) {
  const keywords = {
    'AI Revolution': ['ai', 'artificial intelligence', 'machine learning', 'chatgpt', 'openai'],
    'EV & Clean Energy': ['electric vehicle', 'ev', 'tesla', 'clean energy', 'renewable'],
    'Semiconductor Shortage': ['chip', 'semiconductor', 'nvidia', 'tsmc', 'intel'],
    'Inflation & Fed Policy': ['inflation', 'federal reserve', 'interest rate', 'fed'],
    'Tech Regulation': ['antitrust', 'regulation', 'privacy', 'data protection'],
    'Crypto & Web3': ['bitcoin', 'crypto', 'blockchain', 'web3', 'ethereum']
  };

  const narratives = Object.entries(keywords).map(([name, terms]) => {
    const matches = articles.filter(a => 
      terms.some(term => 
        (a.title + ' ' + a.content).toLowerCase().includes(term)
      )
    );

    return {
      name,
      description: `Coverage of ${name.toLowerCase()} related topics`,
      momentum: matches.length > 10 ? 'hot' : matches.length > 5 ? 'warming' : 'stable',
      confidence: Math.min(matches.length * 10, 95),
      articleCount: matches.length,
      relatedIndustries: getIndustriesForNarrative(name),
      keywords: terms,
      stockSectors: getSectorsForNarrative(name),
      etfSymbols: getETFsForNarrative(name)
    };
  }).filter(n => n.articleCount > 0)
    .sort((a, b) => b.articleCount - a.articleCount);

  return narratives;
}

function getIndustriesForNarrative(name) {
  const mapping = {
    'AI Revolution': ['Technology', 'Software', 'Cloud Computing'],
    'EV & Clean Energy': ['Automotive', 'Energy', 'Materials'],
    'Semiconductor Shortage': ['Technology', 'Manufacturing', 'Electronics'],
    'Inflation & Fed Policy': ['Financial Services', 'Banking', 'Real Estate'],
    'Tech Regulation': ['Technology', 'Legal Services', 'Telecommunications'],
    'Crypto & Web3': ['FinTech', 'Technology', 'Financial Services']
  };
  return mapping[name] || ['General'];
}

function getSectorsForNarrative(name) {
  const mapping = {
    'AI Revolution': ['Technology', 'Communication Services'],
    'EV & Clean Energy': ['Consumer Discretionary', 'Utilities'],
    'Semiconductor Shortage': ['Information Technology', 'Industrials'],
    'Inflation & Fed Policy': ['Financials', 'Real Estate'],
    'Tech Regulation': ['Technology', 'Communication Services'],
    'Crypto & Web3': ['Financials', 'Technology']
  };
  return mapping[name] || ['General'];
}

function getETFsForNarrative(name) {
  const mapping = {
    'AI Revolution': ['BOTZ', 'AIQ', 'IRBO', 'ROBT'],
    'EV & Clean Energy': ['ICLN', 'TAN', 'LIT', 'DRIV'],
    'Semiconductor Shortage': ['SMH', 'SOXX', 'XSD'],
    'Inflation & Fed Policy': ['TIP', 'VTIP', 'SCHP'],
    'Tech Regulation': ['XLK', 'VGT', 'QQQ'],
    'Crypto & Web3': ['BITO', 'GBTC', 'BLOK']
  };
  return mapping[name] || [];
}

// API Endpoints
app.get('/api/test', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'RSS Narrative Tracker API', 
    feeds: ALL_FEEDS.length 
  });
});

app.get('/api/feeds', async (req, res) => {
  try {
    const articles = await fetchAllFeeds();
    res.json({ 
      success: true, 
      count: articles.length,
      articles: articles.slice(0, 50),
      lastUpdated: feedCache.lastUpdated
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/narratives', async (req, res) => {
  try {
    if (!feedCache.data.length || 
        !feedCache.lastUpdated || 
        Date.now() - feedCache.lastUpdated > 300000) {
      await fetchAllFeeds();
    }

    const narratives = await analyzeNarratives(feedCache.data);
    
    res.json({
      success: true,
      narratives,
      articleCount: feedCache.data.length,
      lastUpdated: feedCache.lastUpdated
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sources', (req, res) => {
  res.json({
    success: true,
    sources: ALL_FEEDS.map(f => ({
      name: f.name,
      category: f.category
    })),
    total: ALL_FEEDS.length
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 RSS Narrative Tracker running on http://localhost:${PORT}`);
  console.log(`📡 Monitoring ${ALL_FEEDS.length} news sources`);
  console.log(`🤖 AI Analysis: ${process.env.ANTHROPIC_API_KEY ? 'ENABLED' : 'DISABLED (using keyword extraction)'}`);
});
