require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const db = require('./db');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('FATAL: BOT_TOKEN is missing in .env');
}

const bot = new Bot(token);

function getWebAppUrl(track = '', options = {}) {
  let base = process.env.WEBAPP_URL || 'https://track.loftopt.com';
  // If base is empty, points to onrender.com or localhost, enforce custom domain track.loftopt.com
  if (!base || base.includes('onrender.com') || base.includes('localhost') || !base.startsWith('http')) {
    base = 'https://track.loftopt.com';
  }
  base = base.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (track) {
    params.set('track', track);
  }
  if (options && options.openMap) {
    params.set('openMap', '1');
  }
  const qs = params.toString();
  return qs ? `${base}/?${qs}` : base;
}

// 1. /start command: Minimalist with ONLY the Mini App button
bot.command('start', async (ctx) => {
  console.log(`[Bot] /start received from user ${ctx.from?.id} (${ctx.from?.first_name || ''} @${ctx.from?.username || ''})`);
  const payload = ctx.match; // e.g. track_ABC123
  let targetTrack = '';
  if (payload && payload.startsWith('track_')) {
    targetTrack = payload.replace('track_', '').trim().toUpperCase();
  }

  const appUrl = getWebAppUrl(targetTrack);

  // Set persistent bottom menu button
  try {
    await ctx.setChatMenuButton({
      type: 'web_app',
      text: '📦 Трекер LOFT OPT',
      web_app: { url: getWebAppUrl() }
    });
  } catch (err) {
    console.warn('Could not set chat menu button:', err.message);
  }

  const keyboard = targetTrack
    ? {
        inline_keyboard: [
          [
            {
              text: 'Открыть',
              web_app: { url: getWebAppUrl(targetTrack) },
              style: 'primary'
            },
            {
              text: 'Карта',
              web_app: { url: getWebAppUrl(targetTrack, { openMap: true }) },
              style: 'success'
            }
          ]
        ]
      }
    : new InlineKeyboard().webApp('📦 Открыть трекер LOFT OPT', appUrl);

  const welcomeText = targetTrack 
    ? `Здравствуйте, ${ctx.from.first_name || 'клиент'}!\n\nНажмите кнопку ниже, чтобы открыть карточку накладной <b>${targetTrack}</b> в приложении LOFT OPT.`
    : `Здравствуйте, ${ctx.from.first_name || 'клиент'}!\n\nДобро пожаловать в сервис отслеживания грузов <b>LOFT OPT</b>. Нажмите кнопку ниже для запуска трекера.`;

  await ctx.reply(welcomeText, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
});

function formatTimeRu(rawTime) {
  if (!rawTime) {
    const now = new Date();
    return now.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
  const m = String(rawTime).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (m) {
    return `${m[3]}.${m[2]}.${m[1]}, ${m[4]}`;
  }
  return rawTime;
}

function formatExpectDateRu(rawDate) {
  if (!rawDate) return 'Уточняется';
  const clean = String(rawDate).split(' ')[0].trim();
  const m = clean.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return `${m[3]}.${m[2]}.${m[1]}`;
  }
  return clean || 'Уточняется';
}

// 2. Callback query: Unsubscribe button
bot.callbackQuery(/^unsub:(.+)$/, async (ctx) => {
  const orderNumber = ctx.match[1].trim().toUpperCase();
  const userId = String(ctx.from.id);

  db.unsubscribe(userId, orderNumber);

  await ctx.answerCallbackQuery({
    text: `Отслеживание ${orderNumber} отменено`,
    show_alert: false
  });

  const updatedKeyboard = {
    inline_keyboard: [
      [
        {
          text: 'Открыть',
          web_app: { url: getWebAppUrl(orderNumber) },
          style: 'primary'
        },
        {
          text: 'Карта',
          web_app: { url: getWebAppUrl(orderNumber, { openMap: true }) },
          style: 'success'
        }
      ]
    ]
  };

  try {
    await ctx.editMessageText(
      (ctx.callbackQuery.message?.text || '') + `\n\n<i>🔕 Отслеживание по накладной ${orderNumber} отменено.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: updatedKeyboard
      }
    );
  } catch (e) {
    console.warn('Failed to edit message on unsubscribe:', e.message);
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Send status update notification to a subscriber
 */
async function sendStatusNotification(telegramId, orderItem, latestStep) {
  const orderNumber = orderItem.orderNumber || orderItem.orderNo || '—';
  const point = (latestStep?.context || orderItem.lastContext || latestStep?.trackStatus || orderItem.trackStatus || 'В пути').trim();
  const time = formatTimeRu(latestStep?.trackTime);

  // Distance metrics
  const distance = orderItem.distance || orderItem.routeMetrics;
  let coveredKm = distance?.coveredKm;
  let remainingKm = distance?.remainingKm;

  if (coveredKm == null || remainingKm == null) {
    try {
      const routeService = require('./routeService');
      const rm = routeService.calculateRouteMetrics(
        orderItem.lastLat,
        orderItem.lastLng,
        orderItem.details,
        orderItem.getGoodsAddr,
        orderItem.targetMarket
      );
      if (coveredKm == null) coveredKm = rm.coveredKm;
      if (remainingKm == null) remainingKm = rm.remainingKm;
    } catch (_) {}
  }

  const coveredStr = (coveredKm != null && !isNaN(coveredKm)) ? `~${Number(coveredKm).toLocaleString('ru-RU')} км` : '—';
  const remainingStr = (remainingKm != null && !isNaN(remainingKm)) ? `~${Number(remainingKm).toLocaleString('ru-RU')} км` : '—';

  let message = `📦 <b>Обновление статуса!</b>\n\n`;
  message += `Груз: <code>${escapeHtml(orderNumber)}</code>\n`;
  message += `📍 Статус: <b>${escapeHtml(point)}</b>\n`;
  message += `🕒 Время: ${escapeHtml(time)}\n`;
  message += `🚗 Пройдено: ${coveredStr}\n`;
  message += `🏁 Осталось: ${remainingStr}`;

  // Notification buttons: "Открыть" (primary blue) and "Карта" (success green)
  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: 'Открыть',
          web_app: { url: getWebAppUrl(orderNumber) },
          style: 'primary'
        },
        {
          text: 'Карта',
          web_app: { url: getWebAppUrl(orderNumber, { openMap: true }) },
          style: 'success'
        }
      ]
    ]
  };

  try {
    await bot.api.sendMessage(telegramId, message, {
      parse_mode: 'HTML',
      reply_markup
    });
    return true;
  } catch (err) {
    console.error(`Failed to send notification to ${telegramId} for ${orderNumber}:`, err.message);
    if (err.error_code === 403) {
      db.unsubscribe(telegramId, orderNumber);
    }
    return false;
  }
}

module.exports = {
  bot,
  sendStatusNotification,
  getWebAppUrl
};
