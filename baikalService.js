const { calculateRouteMetrics } = require('./routeService');

const API_URL = 'https://gateway-saas.baikalasia.com/bison-oms/oms/track/searchTrack?lang=ru_RU';

function normalizeOrder(rawItem) {
  if (!rawItem) return null;

  const isNotFound = !rawItem.id && !rawItem.customerNo;
  const orderNumber = rawItem.customerNo || rawItem.orderNo;

  if (isNotFound) {
    return {
      orderNumber,
      orderNo: rawItem.orderNo,
      customerNo: null,
      notFound: true,
      message: 'Груз не найден в системе логистики'
    };
  }

  // Target market normalization
  let targetMarket = rawItem.targetMarket_dictText || rawItem.targetMarket || 'Рябинск';
  const tm = String(targetMarket).trim();
  if (/^рябинск$/i.test(tm)) {
    targetMarket = 'Москва (Рябинск)';
  } else if (/^рябиновая$/i.test(tm)) {
    targetMarket = 'Москва (Рябиновая)';
  } else if (/^(южные ворота|тяк|люблино|садовод|северные ворота)$/i.test(tm)) {
    targetMarket = `Москва (${tm})`;
  }

  // Format track list (details)
  const trackList = Array.isArray(rawItem.trackList) ? rawItem.trackList : [];
  const details = trackList.map(t => ({
    trackTime: t.appendTime || '',
    trackStatus: t.trackStatus || '',
    trackStatusId: t.trackStatusId || null,
    context: t.contextForeign || t.context || '',
    lat: t.lat ? Number(t.lat) : null,
    lng: t.lng ? Number(t.lng) : null,
    isChina: t.isChina
  }));

  const origin = rawItem.getGoodsAddr || 'Город Иу';
  const currentStatus = rawItem.lastTrackStatus || rawItem.trackStatus || 'В пути';

  // Calculate distance & route metrics
  const routeMetrics = calculateRouteMetrics(
    rawItem.lastLat,
    rawItem.lastLng,
    details,
    origin,
    targetMarket
  );

  return {
    orderNumber: rawItem.customerNo || rawItem.orderNo,
    orderNo: rawItem.orderNo,
    customerNo: rawItem.customerNo,
    status: currentStatus,
    trackStatus: currentStatus,
    trackStatusId: rawItem.lastTrackStatusId,
    getGoodsAddr: origin,
    targetMarket,
    targetCity: rawItem.targetCity_dictText || 'Москва',
    expectArriveTime: rawItem.expectArriveTime || null,
    carBoxNo: rawItem.carBoxNo || null,
    lastLat: rawItem.lastLat ? Number(rawItem.lastLat) : null,
    lastLng: rawItem.lastLng ? Number(rawItem.lastLng) : null,
    lastContext: rawItem.lastContextForeign || rawItem.lastContext || '',
    details,
    routeMetrics,
    distance: {
      coveredKm: routeMetrics.coveredKm,
      remainingKm: routeMetrics.remainingKm,
      totalKm: routeMetrics.totalKm,
      progressPercent: routeMetrics.progressPercent
    }
  };
}

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
        stringList: list
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error(`Baikal API returned status ${response.status}`);
    }

    const data = await response.json();
    if (data && Array.isArray(data.result) && data.result.length > 0) {
      // Find the tab containing all orders (usually "Все" at index 0)
      const allTab = data.result.find(t => t.tab === 'Все') || data.result[0];
      const items = Array.isArray(allTab.data) ? allTab.data : [];
      return items.map(normalizeOrder).filter(Boolean);
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
    if (item.notFound) {
      return { notFound: true, message: item.message || 'Груз не найден' };
    }
    return item;
  }
};

module.exports = baikalService;
