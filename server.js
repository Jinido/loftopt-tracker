require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const baikalService = require('./baikalService');
const { bot, sendStatusNotification } = require('./bot');
const worker = require('./worker');

const app = express();
const PORT = process.env.PORT || 8085;

app.use(cors());
app.use(express.json());

// Serve static frontend files (Mini App)
app.use(express.static(path.join(__dirname)));

// 1. Cargo Tracking API (Proxy to Baikal Logistics to avoid CORS / rate issues)
app.post('/api/track', async (req, res) => {
  try {
    const { orderNumber } = req.body;
    if (!orderNumber || !String(orderNumber).trim()) {
      return res.status(400).json({ error: 'Укажите номер накладной' });
    }

    const cleanOrder = String(orderNumber).trim().toUpperCase();
    const result = await baikalService.searchSingle(cleanOrder);

    if (!result) {
      return res.status(404).json({ error: 'Груз не найден в системе' });
    }

    if (result.notFound) {
      return res.status(404).json({ error: result.message || 'Груз не найден' });
    }

    res.json(result);
  } catch (err) {
    console.error('API /api/track error:', err.message);
    res.status(500).json({ error: 'Не удалось получить данные от сервера логистики' });
  }
});

// Image proxy for cargo photos (bypasses Aliyun OSS forced downloads & ensures inline display)
app.get('/api/image-proxy', async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl || typeof rawUrl !== 'string') {
      return res.status(400).send('Missing url parameter');
    }

    const parsed = new URL(rawUrl);
    if (!parsed.hostname.endsWith('aliyuncs.com') && !parsed.hostname.endsWith('baikalasia.com')) {
      return res.status(403).send('Forbidden host');
    }

    const response = await fetch(rawUrl, {
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.status(response.status).send('Failed to load image');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('[ImageProxy] Error:', err.message);
    res.status(500).send('Error loading image');
  }
});

// 2. Subscription Status API
app.get('/api/subscription-status', (req, res) => {
  const { telegramId, orderNumber } = req.query;
  if (!telegramId || !orderNumber) {
    return res.status(400).json({ error: 'telegramId and orderNumber are required' });
  }

  const sub = db.getSubscription(telegramId, orderNumber);
  res.json({
    isSubscribed: !!(sub && sub.is_active === 1),
    subscription: sub || null
  });
});

// 3. Subscribe to Cargo Updates API
app.post('/api/subscribe', async (req, res) => {
  try {
    const { telegramId, orderNumber, currentStatus, currentContext, currentTime } = req.body;
    console.log(`[API] Subscription request for order ${orderNumber} from user ${telegramId}`);

    if (!telegramId || !orderNumber) {
      return res.status(400).json({ error: 'telegramId and orderNumber are required' });
    }

    const sub = db.subscribe(
      telegramId,
      orderNumber,
      currentStatus || '',
      currentContext || '',
      currentTime || ''
    );

    res.json({
      success: true,
      subscription: sub
    });
  } catch (err) {
    console.error('API /api/subscribe error:', err.message);
    res.status(500).json({ error: 'Ошибка сохранения подписки' });
  }
});

// 4. Unsubscribe from Cargo Updates API
app.post('/api/unsubscribe', (req, res) => {
  try {
    const { telegramId, orderNumber } = req.body;
    if (!telegramId || !orderNumber) {
      return res.status(400).json({ error: 'telegramId and orderNumber are required' });
    }

    db.unsubscribe(telegramId, orderNumber);
    res.json({ success: true });
  } catch (err) {
    console.error('API /api/unsubscribe error:', err.message);
    res.status(500).json({ error: 'Ошибка отмены подписки' });
  }
});

// In-memory cache for road route coordinates
const roadRouteCache = new Map();

// 5. Road Routing API (OSRM Highway Proxy with in-memory caching)
app.get('/api/road-route', async (req, res) => {
  try {
    const { coords } = req.query;
    if (!coords || typeof coords !== 'string') {
      return res.status(400).json({ error: 'Missing coords query parameter' });
    }

    const cleanCoords = coords.trim();
    const cached = roadRouteCache.get(cleanCoords);
    if (cached && (Date.now() - cached.time < 7200000)) { // 2 hours cache
      return res.json({ success: true, coordinates: cached.data });
    }

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${cleanCoords}?overview=full&geometries=geojson`;
    const response = await fetch(osrmUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(6000)
    });

    if (!response.ok) {
      throw new Error(`OSRM HTTP status ${response.status}`);
    }

    const data = await response.json();
    if (data.code === 'Ok' && data.routes && data.routes[0]?.geometry?.coordinates) {
      const latLngs = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
      roadRouteCache.set(cleanCoords, { time: Date.now(), data: latLngs });
      if (roadRouteCache.size > 200) {
        const firstKey = roadRouteCache.keys().next().value;
        roadRouteCache.delete(firstKey);
      }
      return res.json({ success: true, coordinates: latLngs });
    }

    res.status(422).json({ error: 'Could not calculate road route' });
  } catch (err) {
    console.warn('[Server] /api/road-route proxy error:', err.message);
    res.status(502).json({ error: 'Routing service temporarily unavailable' });
  }
});

// 6. Developer Test Endpoints
app.post('/api/test-notify', async (req, res) => {
  const { telegramId, orderNumber, newStatus, newContext } = req.body;
  if (!telegramId || !orderNumber) {
    return res.status(400).json({ error: 'telegramId and orderNumber are required' });
  }

  const dummyItem = {
    orderNumber,
    trackStatus: newStatus || 'В пути',
    getGoodsAddr: 'Гуанчжоу',
    targetMarket: 'Москва (Южные Ворота)',
    carBoxNo: 'CARGO-774-RU',
    lastLat: 34.048983,
    lastLng: 109.89995,
    distance: {
      coveredKm: 2268,
      remainingKm: 6931,
      totalKm: 9199,
      progressPercent: 25
    }
  };

  const dummyStep = {
    trackStatus: newStatus || 'В пути',
    trackTime: new Date().toLocaleString('ru-RU'),
    context: newContext || 'Район обслуживания Шанлуо, район Шанчжоу, город Шанлуо, провинция Шэньси'
  };

  const sent = await sendStatusNotification(telegramId, dummyItem, dummyStep);
  res.json({ success: sent });
});

app.post('/api/trigger-poll', async (req, res) => {
  worker.pollAllOrders().catch(e => console.error(e));
  res.json({ message: 'Poll cycle triggered in background' });
});

// SPA fallback: send index.html for direct URLs (e.g. /LFT991230016 or /app/LFT991230016)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  next();
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`[Server] LOFT OPT Cargo Tracker running on http://localhost:${PORT}`);
});

// Start Telegram Bot Polling
bot.start({
  onStart: (botInfo) => {
    console.log(`[Bot] Telegram Bot @${botInfo.username} started successfully.`);
  }
}).catch(err => {
  console.error('[Bot] Failed to start bot polling:', err.message);
});

// Start Background Worker Scheduler
worker.startScheduler();
