require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const db = require('./db');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('FATAL: BOT_TOKEN is missing in .env');
}

const bot = new Bot(token);

function getWebAppUrl(track = '') {
  let base = process.env.WEBAPP_URL || 'http://localhost:8085';
  base = base.replace(/\/+$/, '');
  if (track) {
    return `${base}/?track=${encodeURIComponent(track)}`;
  }
  return base;
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

  const keyboard = new InlineKeyboard()
    .webApp('📦 Открыть трекер LOFT OPT', appUrl);

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

/**
 * Send status update notification to a subscriber
 */
async function sendStatusNotification(telegramId, orderItem, latestStep) {
  const orderNumber = orderItem.orderNumber || orderItem.orderNo;
  const status = latestStep?.trackStatus || orderItem.trackStatus || 'Статус обновлен';
  const time = formatTimeRu(latestStep?.trackTime);
  const origin = orderItem.getGoodsAddr || 'Фошань';
  const destination = orderItem.targetMarket || orderItem.arriveCity || 'Москва (Рябинск)';
  const route = (origin && destination) ? `${origin} ➔ ${destination}` : (destination || origin || 'Уточняется');
  const expectDate = formatExpectDateRu(orderItem.expectArriveTime);

  let message = `📦 <b>Обновление статуса!</b>\n\n`;
  message += `Груз: <code>${orderNumber}</code>\n`;
  message += `📍 Статус: <b>${status}</b>\n`;
  message += `🕒 Время: ${time}\n`;
  message += `🛣 Маршрут: ${route}\n`;
  message += `📅 Ожидаемое прибытие: ${expectDate}`;

  // Single green button: "Открыть" (opens Mini App)
  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: 'Открыть',
          web_app: { url: getWebAppUrl(orderNumber) },
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
