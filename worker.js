const cron = require('node-cron');
const db = require('./db');
const baikalService = require('./baikalService');
const { sendStatusNotification } = require('./bot');

const TERMINAL_STATUSES = [
  'выдан',
  'получен',
  'доставлен',
  'вручен',
  'завершен'
];

function isTerminalStatus(status = '') {
  const s = String(status).toLowerCase();
  return TERMINAL_STATUSES.some(t => s.includes(t));
}

let isPolling = false;

async function pollAllOrders() {
  if (isPolling) {
    console.log('[Worker] Previous polling cycle still in progress, skipping...');
    return;
  }

  isPolling = true;
  console.log('[Worker] Starting polling cycle for active cargo tracks...');

  try {
    const activeOrders = db.getActiveUniqueOrders();
    if (activeOrders.length === 0) {
      console.log('[Worker] No active subscriptions found.');
      isPolling = false;
      return;
    }

    console.log(`[Worker] Found ${activeOrders.length} unique active track(s) to check.`);

    // Batch in chunks of 15 to stay gentle on Baikal API
    const chunkSize = 15;
    for (let i = 0; i < activeOrders.length; i += chunkSize) {
      const chunk = activeOrders.slice(i, i + chunkSize);

      try {
        const results = await baikalService.searchOrders(chunk);

        for (const item of results) {
          const orderNumber = (item.orderNumber || item.orderNo || '').trim().toUpperCase();
          if (!orderNumber) continue;

          // If not found in logistics system
          if (item.code === '400' || item.failMessage) continue;

          const details = Array.isArray(item.details) ? item.details : [];
          const latestStep = details.length > 0 ? details[0] : null;

          const currentStatus = (latestStep?.trackStatus || item.trackStatus || item.status || '').trim();
          const currentContext = (latestStep?.context || '').trim();
          const currentTime = (latestStep?.trackTime || '').trim();

          const subscribers = db.getSubscribersForOrder(orderNumber);

          for (const sub of subscribers) {
            const hasChanged = (sub.last_status !== currentStatus) || 
                              (currentTime && sub.last_time !== currentTime);

            if (hasChanged) {
              console.log(`[Worker] Status change detected for ${orderNumber} (User: ${sub.telegram_id}): "${sub.last_status}" -> "${currentStatus}"`);

              // Only send message if there was a previous status (prevents spam on initial subscription)
              if (sub.last_status) {
                await sendStatusNotification(sub.telegram_id, item, latestStep);
              }

              // Update DB with latest status info
              db.updateStatus(sub.id, currentStatus, currentContext, currentTime);

              // If order reached terminal status, deactivate future tracking
              if (isTerminalStatus(currentStatus)) {
                console.log(`[Worker] Order ${orderNumber} has reached terminal status "${currentStatus}". Deactivating subscription for user ${sub.telegram_id}.`);
                db.unsubscribe(sub.telegram_id, orderNumber);
              }
            }
          }
        }
      } catch (chunkErr) {
        console.error(`[Worker] Error checking chunk [${chunk.join(', ')}]:`, chunkErr.message);
      }

      // Small delay between chunks
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log('[Worker] Polling cycle completed successfully.');
  } catch (err) {
    console.error('[Worker] Fatal error during polling cycle:', err);
  } finally {
    isPolling = false;
  }
}

function startScheduler() {
  // Run once every 1 hour (at minute 0)
  // '0 * * * *' = every hour at minute 0
  cron.schedule('0 * * * *', () => {
    console.log('[Worker] Hourly cron triggered.');
    pollAllOrders();
  });

  console.log('[Worker] Hourly background scheduler initialized.');
}

module.exports = {
  startScheduler,
  pollAllOrders
};
