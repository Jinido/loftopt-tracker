const { calculateRouteMetrics } = require('./routeService');

const API_URL = 'https://gateway-saas.baikalasia.com/bison-oms/oms/track/searchTrack?lang=ru_RU';
const DETAIL_API_URL = process.env.BAIKAL_DETAIL_API_URL || 'https://gateway-saas.baikalasia.com/oapi/v1/order/detail';

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
    totalWeight: null,
    totalVolume: null,
    quantityBox: null,
    totalDensity: null,
    packagedFiles: [],
    goodsFiles: [],
    goodsName: '',
    businessType: '',
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
   * Fetch order details (photos, packaging, weight, volume) from Baikal Open API v1
   * @param {string} orderNumber 
   */
  async getOrderDetail(orderNumber) {
    const apiKey = process.env.BAIKAL_API_KEY;
    if (!apiKey) return null;

    const ordNo = String(orderNumber).trim().toUpperCase();
    if (!ordNo) return null;

    try {
      const response = await fetch(DETAIL_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'apiKey': apiKey,
          'lang': 'ru_RU'
        },
        body: JSON.stringify({ ordNo }),
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        console.warn(`[BaikalService] Detail API HTTP error ${response.status}`);
        return null;
      }

      const json = await response.json();
      if (json && json.success && json.result) {
        return json.result;
      }
      return null;
    } catch (err) {
      console.warn(`[BaikalService] Detail API fetch failed for ${ordNo}:`, err.message);
      return null;
    }
  },

  /**
   * Search single order helper with merged tracking and detail metrics
   */
  async searchSingle(orderNumber) {
    const cleanNum = String(orderNumber).trim().toUpperCase();
    if (!cleanNum) return null;

    // Fetch tracking checkpoints and details concurrently
    const [trackingResults, detailData] = await Promise.all([
      this.searchOrders([cleanNum]).catch(err => {
        console.warn('[BaikalService] Tracking search error:', err.message);
        return [];
      }),
      this.getOrderDetail(cleanNum).catch(() => null)
    ]);

    let item = (trackingResults && trackingResults.length > 0) ? trackingResults[0] : null;

    // If tracking not found but detailData exists
    if (!item || item.notFound) {
      if (detailData) {
        return {
          orderNumber: detailData.customerNo || detailData.orderNo || cleanNum,
          orderNo: detailData.orderNo,
          customerNo: detailData.customerNo,
          status: detailData.completeTime ? 'Выдан' : (detailData.sendTime ? 'В пути' : 'Поступил на склад'),
          trackStatus: detailData.completeTime ? 'Выдан' : (detailData.sendTime ? 'В пути' : 'Поступил на склад'),
          getGoodsAddr: 'Склад в Китае',
          targetMarket: 'Москва',
          targetCity: 'Москва',
          expectArriveTime: detailData.expectArriveTime || null,
          totalWeight: detailData.totalWeight || null,
          totalVolume: detailData.totalVolume || null,
          quantityBox: detailData.quantityBox || null,
          totalDensity: detailData.totalDensity || null,
          packagedFiles: Array.isArray(detailData.packagedFiles) ? detailData.packagedFiles : [],
          goodsFiles: Array.isArray(detailData.goodsFiles) ? detailData.goodsFiles : [],
          goodsName: detailData.goodsName || '',
          businessType: detailData.businessType || '',
          details: [],
          distance: {
            coveredKm: null,
            remainingKm: null,
            totalKm: null,
            progressPercent: 0
          }
        };
      }
      if (item && item.notFound) {
        return { notFound: true, message: item.message || 'Груз не найден' };
      }
      return null;
    }

    // Merge detail data into the tracking item
    let detail = detailData;
    // If detail wasn't resolved by the primary code (e.g. user entered customerNo or vice-versa), try with the other
    if (!detail) {
      const altNum = (cleanNum === item.orderNo ? item.customerNo : item.orderNo);
      if (altNum && altNum !== cleanNum) {
        detail = await this.getOrderDetail(altNum);
      }
    }

    if (detail) {
      item.totalWeight = detail.totalWeight || null;
      item.totalVolume = detail.totalVolume || null;
      item.quantityBox = detail.quantityBox || null;
      item.totalDensity = detail.totalDensity || null;
      item.packagedFiles = Array.isArray(detail.packagedFiles) ? detail.packagedFiles : [];
      item.goodsFiles = Array.isArray(detail.goodsFiles) ? detail.goodsFiles : [];
      item.goodsName = detail.goodsName || '';
      item.businessType = detail.businessType || '';
      if (!item.expectArriveTime && detail.expectArriveTime) {
        item.expectArriveTime = detail.expectArriveTime;
      }
    }

    return item;
  }
};

module.exports = baikalService;
