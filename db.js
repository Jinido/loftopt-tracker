const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'tracker.db');
const db = new Database(dbPath);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    order_number TEXT NOT NULL,
    last_status TEXT,
    last_context TEXT,
    last_time TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(telegram_id, order_number)
  );

  CREATE INDEX IF NOT EXISTS idx_active_orders ON subscriptions (order_number, is_active);
  CREATE INDEX IF NOT EXISTS idx_user_orders ON subscriptions (telegram_id, is_active);
`);

const statements = {
  getSubscription: db.prepare(`
    SELECT * FROM subscriptions 
    WHERE telegram_id = ? AND order_number = ? AND is_active = 1
  `),

  getUserSubscriptions: db.prepare(`
    SELECT * FROM subscriptions 
    WHERE telegram_id = ? AND is_active = 1 
    ORDER BY updated_at DESC
  `),

  getActiveUniqueOrders: db.prepare(`
    SELECT DISTINCT order_number 
    FROM subscriptions 
    WHERE is_active = 1
  `),

  getSubscribersForOrder: db.prepare(`
    SELECT * FROM subscriptions 
    WHERE order_number = ? AND is_active = 1
  `),

  upsertSubscription: db.prepare(`
    INSERT INTO subscriptions (telegram_id, order_number, last_status, last_context, last_time, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id, order_number) DO UPDATE SET
      last_status = excluded.last_status,
      last_context = excluded.last_context,
      last_time = excluded.last_time,
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
  `),

  deactivateSubscription: db.prepare(`
    UPDATE subscriptions 
    SET is_active = 0, updated_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ? AND order_number = ?
  `),

  updateSubscriptionStatus: db.prepare(`
    UPDATE subscriptions 
    SET last_status = ?, last_context = ?, last_time = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
};

module.exports = {
  db,
  getSubscription(telegramId, orderNumber) {
    return statements.getSubscription.get(String(telegramId), String(orderNumber).trim().toUpperCase());
  },
  getUserSubscriptions(telegramId) {
    return statements.getUserSubscriptions.all(String(telegramId));
  },
  getActiveUniqueOrders() {
    return statements.getActiveUniqueOrders.all().map(row => row.order_number);
  },
  getSubscribersForOrder(orderNumber) {
    return statements.getSubscribersForOrder.all(String(orderNumber).trim().toUpperCase());
  },
  subscribe(telegramId, orderNumber, lastStatus = '', lastContext = '', lastTime = '') {
    const cleanOrder = String(orderNumber).trim().toUpperCase();
    statements.upsertSubscription.run(String(telegramId), cleanOrder, lastStatus, lastContext, lastTime);
    return this.getSubscription(telegramId, cleanOrder);
  },
  unsubscribe(telegramId, orderNumber) {
    const cleanOrder = String(orderNumber).trim().toUpperCase();
    statements.deactivateSubscription.run(String(telegramId), cleanOrder);
    return true;
  },
  updateStatus(id, newStatus, newContext, newTime) {
    statements.updateSubscriptionStatus.run(newStatus, newContext, newTime, id);
  }
};
