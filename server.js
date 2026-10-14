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

// 5. Developer Test Endpoints
app.post('/api/test-notify', async (req, res) => {
  const { telegramId, orderNumber, newStatus, newContext } = req.body;
  if (!telegramId || !orderNumber) {
    return res.status(400).json({ error: 'telegramId and orderNumber are required' });
  }

  const dummyItem = {
    orderNumber,
    trackStatus: newStatus || 'Прибыл на распределительный склад',
    getGoodsAddr: 'Гуанчжоу',
    targetMarket: 'Москва (Южные Ворота)',
    carBoxNo: 'CARGO-774-RU',
    expectArriveTime: new Date(Date.now() + 86400000 * 3).toISOString()
  };

  const dummyStep = {
    trackStatus: newStatus || 'Прибыл на распределительный склад',
    trackTime: new Date().toLocaleString('ru-RU'),
    context: newContext || 'Партия принята к сортировке и таможенному оформлению'
  };

  const sent = await sendStatusNotification(telegramId, dummyItem, dummyStep);
  res.json({ success: sent });
});

app.post('/api/trigger-poll', async (req, res) => {
  worker.pollAllOrders().catch(e => console.error(e));
  res.json({ message: 'Poll cycle triggered in background' });
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
