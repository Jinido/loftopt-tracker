const API_URL = 'https://gateway-saas.baikalasia.com/bison-oms/oms/platform/searchTrack';

const baikalService = {
  /**
   * Search one or multiple orders in Baikal Logistics API
   * @param {string[]|string} orderNumbers 
   */
  async searchOrders(orderNumbers) {
    const list = (Array.isArray(orderNumbers) ? orderNumbers : [orderNumbers])
      .map(s => String(s).trim().toUpperCase())
      .filter(Boolean);

    if (list.length === 0) {
      return [];
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        orderNumbers: list,
        lang: 'ru_RU'
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`Baikal API returned status ${response.status}`);
    }

function normalizeOrder(item) {
  if (!item) return item;
  if (item.targetMarket) {
    const tm = String(item.targetMarket).trim();
    if (/^рябинск$/i.test(tm)) {
      item.targetMarket = 'Москва (Рябинск)';
    } else if (/^рябиновая$/i.test(tm)) {
      item.targetMarket = 'Москва (Рябиновая)';
    } else if (/^(южные ворота|тяк|люблино|садовод|северные ворота)$/i.test(tm)) {
      item.targetMarket = `Москва (${tm})`;
    }
  }
  return item;
}

    const data = await response.json();
    if (data && Array.isArray(data.result)) {
      return data.result.map(normalizeOrder);
    }
    return [];
  },

  /**
   * Search single order helper
   */
  async searchSingle(orderNumber) {
    const results = await this.searchOrders([orderNumber]);
    if (!results || results.length === 0) return null;
    const item = results[0];
    if (item.code === '400' || item.failMessage) {
      return { notFound: true, message: item.failMessage || 'Груз не найден' };
    }
    return item;
  }
};

module.exports = baikalService;
