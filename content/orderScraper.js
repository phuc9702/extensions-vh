/**
 * VH Etsy Order Sync - Order Scraper
 * Extracts order data from Etsy order pages
 * Based on actual Etsy HTML structure (Dec 2025)
 */

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.__VH_ETSY_SCRAPER__) return;
  window.__VH_ETSY_SCRAPER__ = true;

  /**
   * Utility functions
   */
  const Utils = {
    wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

    safeText: (el) => el?.textContent?.trim() || '',

    // Normalize typography characters and HTML entities to ASCII equivalents
    normalizeText: (s) => {
      if (!s) return s;
      // Decode HTML entities first (&#39; → ', &amp; → &, etc.)
      const textarea = document.createElement('textarea');
      textarea.innerHTML = s;
      s = textarea.value;
      return s
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")  // curly/typographic apostrophes
        .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // curly double quotes
        .replace(/[\u2013\u2014]/g, '-')                           // en/em dash
        .trim();
    },
    // Get text from data-test-id="unsanitize" elements
    getUnsanitizedText: (container, index = 0) => {
      const els = container?.querySelectorAll('[data-test-id="unsanitize"]');
      return els?.[index]?.textContent?.trim() || '';
    },

    parsePrice: (text) => {
      if (!text) return { amount: null, currency: 'USD' };

      text = text.replace(/\s+/g, ' ').trim();

      const currencyMap = {
        '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₫': 'VND',
        'US$': 'USD', 'USD': 'USD', 'EUR': 'EUR', 'GBP': 'GBP'
      };

      let currency = 'USD';
      let amount = null;

      for (const [symbol, code] of Object.entries(currencyMap)) {
        if (text.includes(symbol)) {
          currency = code;
          text = text.replace(symbol, '');
          break;
        }
      }

      const numMatch = text.match(/[\d.,]+/);
      if (numMatch) {
        let numStr = numMatch[0];
        if (numStr.includes(',') && numStr.includes('.')) {
          if (numStr.lastIndexOf(',') > numStr.lastIndexOf('.')) {
            numStr = numStr.replace(/\./g, '').replace(',', '.');
          } else {
            numStr = numStr.replace(/,/g, '');
          }
        } else if (numStr.includes(',')) {
          const parts = numStr.split(',');
          if (parts[parts.length - 1].length === 2) {
            numStr = numStr.replace(',', '.');
          } else {
            numStr = numStr.replace(/,/g, '');
          }
        }
        amount = parseFloat(numStr);
      }

      return { amount: isNaN(amount) ? null : amount, currency };
    },

    formatDate: (dateStr) => {
      if (!dateStr) return null;
      try {
        const date = new Date(dateStr);
        return !isNaN(date) ? date.toISOString() : null;
      } catch {
        return null;
      }
    },

    // Parse Etsy "Ordered 2:02am, Tue, May 5, 2026" → ISO string
    // Không dùng new Date() để tránh browser timezone làm lệch ngày
    parseEtsyOrderedDate: (timeStr, dateStr) => {
      try {
        const MONTHS = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
        const timeParts = timeStr.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
        if (!timeParts) return null;
        let h = parseInt(timeParts[1]);
        const m = parseInt(timeParts[2]);
        const ampm = timeParts[3].toLowerCase();
        if (ampm === 'pm' && h !== 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
        const dateParts = dateStr.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
        if (!dateParts) return null;
        const month = MONTHS[dateParts[1].slice(0, 3)];
        if (!month) return null;
        const day = parseInt(dateParts[2]);
        const year = parseInt(dateParts[3]);
        const hStr = String(h).padStart(2, '0');
        const mStr = String(m).padStart(2, '0');
        const monthStr = String(month).padStart(2, '0');
        const dayStr = String(day).padStart(2, '0');
        // Gửi y chang giờ Etsy hiển thị, không có timezone suffix
        return `${year}-${monthStr}-${dayStr}T${hStr}:${mStr}:00`;
      } catch {
        return null;
      }
    },

    // Strip trailing "US letter" / "US LETTER" suffix from variation values
    // e.g. "T-shirt - L US letter" → "T-shirt - L"
    stripUSLetterSuffix: (s) => {
      if (!s) return s;
      return s.replace(/\s+US\s+letter\s*$/i, '').trim();
    },

    // Normalize a variation value: strip US letter suffix + normalize typography
    normalizeVariationValue: (s) => {
      if (!s) return s;
      return Utils.normalizeText(Utils.stripUSLetterSuffix(s));
    }
  };

  /**
   * Order Scraper Class - Based on actual Etsy HTML structure
   */
  class EtsyOrderScraper {
    constructor() {
      this.orders = [];
      this._typeMap = null;
      this._colorStyleMap = null;
      this._shopId = null;
    }

    // Extract Etsy numeric shop ID from XHR resource URLs already loaded by the page
    async getShopId() {
      if (this._shopId) return this._shopId;
      // Method 1: scan performance resource URLs (XHR/fetch made by Etsy SPA)
      try {
        for (const res of performance.getEntriesByType('resource')) {
          const m = res.name.match(/\/api\/v3\/ajax\/shop\/(\d+)\//);
          if (m) { this._shopId = m[1]; return this._shopId; }
        }
      } catch {}
      // Method 2: search embedded JSON in script tags
      for (const script of document.querySelectorAll('script:not([src])')) {
        const m = script.textContent.match(/"shop_id"\s*[:"]+\s*(\d+)/);
        if (m) { this._shopId = m[1]; return this._shopId; }
      }
      return null;
    }

    // Call Etsy earnings API directly — no DOM scraping, no stale data
    async fetchEarnings(orderId) {
      const shopId = await this.getShopId();
      if (!shopId) return null;
      try {
        const url = `https://www.etsy.com/api/v3/ajax/shop/${shopId}/mission-control/orders/earnings/${orderId}/details/all?include_refunded_labels=true&include_vat_in_sum=true`;
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data?.total?.amount !== undefined && data.total.divisor) {
          return data.total.amount / data.total.divisor;
        }
      } catch (e) {
        console.warn('[VH Scraper] fetchEarnings API failed:', e);
      }
      return null;
    }

    /**
     * Load variant type mappings from backend API.
     * Cached for the lifetime of this scraper instance.
     * Falls back to hardcoded defaults if API is unavailable.
     */
    async loadTypeMappings() {
      if (this._typeMap && this._colorStyleMap) return; // already loaded

      const DEFAULT_TYPE_MAP = {
        'T-Shirt': 'T-shirt', 'TShirt': 'T-shirt', 'Hoodie': 'Hoodie', 'Sweatshirt': 'Sweatshirt',
        'Comfort TShirt': 'Comfort colors t-shirt',
        'Comfort T-shirt': 'Comfort colors t-shirt',
        'Comfort Colors': 'Comfort colors t-shirt',
        'Comfort': 'Comfort colors t-shirt',
        'Wash T-shirt': 'Mineral Wash Colortone 1300',
        'Tough Cases (iPhone)': 'Tough Cases (iPhone)',
        'Football Jersey': '3D-VN  Mesh football jersey',
        'Mesh Football Jersey': '3D-VN  Mesh football jersey',
        'Baseball Jersey': '3D-VN PREMIUM BASEBALL JERSEY (BORDERS)',
        'Kid Jersey': '3D-VN Kid Youth Baseball Jersey Border',
        'Croptop Football': '3D-VN All-Over Print Mesh Football Crop Top Jersey',
        'AOP Mesh FB Crop Top Jersey': '3D-VN All-Over Print Mesh Football Crop Top Jersey',
        'AOP Player Football Jersey': '3D-VN All Over Print Player Football Jersey',
        'AOP Lace Neck Hockey Jersey': '3D-VN MF All-over Print Lace Neck Hockey Jersey',
        'AOP Hockey Jersey': '3D-VN MF All-over Print Hockey Jersey',
        'AOP V-Neck Hockey Jersey': '3D-VN AOP V-Neck Hockey Jersey',
        'AOP Seamless': '3D-VN All-Over Print Seamless Sleeve T-shirt',
        'Polo Men Shirt': '3D-VN All Over Print Men Polo Premium Shirt',
        'Polo Women Shirt': '3D-VN All Over Print Women Polo Premium Shirt',
        'Die Sticker': 'Die-cut Stickers US 2',
        'Kiss Sticker': 'Kiss-cut Stickers US 2',
        'Poster': 'Premium Luster Photo Paper Poster US 2',
        'Ceramic Mug': 'Ceramic Mug US 2',
        'Accent Mug': 'Accent Mug US 2',
        'Acrylic Keychain': 'Acrylic Keychain US',
        'Keychain': 'Acrylic Keychain US',
        'Keychain 2 Side': 'Acrylic Keychain 2 side US',
        'Keychain 2side': 'Acrylic Keychain 2 side US',
        '2 Side Keychain': 'Acrylic Keychain 2 side US',
        '2Side Keychain': 'Acrylic Keychain 2 side US',
        'Suncatcher': 'Window Hanging Suncatcher Ornaments 1 layer US',
        'Normal Shirt': '3D-VN US HAWAIIAN SHIRT',
        'Hawaiian Shirt': '3D-VN US HAWAIIAN SHIRT',
        'Classic Dad Hat': 'Classic Dad Hat',
        'Premium Embroidery': 'Classic Dad Hat',
        'Classic Printed': 'Classic Dad Hat',
        'Baseball Hat': 'Baseball Hat',
        'Embroidery Baseball Hat': 'Baseball Hat',
        'Trucker Hat': 'Trucker Hat',
        'Double Printed Flag': '3D-VN USA Polyester and Double Printed Flag',
        '3D Printed Flag': '3D-VN USA Polyester and Double Printed Flag',
        'Flag': '3D-VN USA Polyester and Double Printed Flag',
        'Greeting Card': 'Greetingcard',
        'Card': 'Greetingcard',
      };
      const DEFAULT_COLOR_STYLE_MAP = {};

      try {
        const manifest = chrome.runtime.getManifest();
        const apiUrl = manifest.api_url || 'https://vhmediaco.app';
        const { accessToken } = await chrome.storage.local.get('accessToken');

        if (!accessToken) {
          console.warn('[VH Scraper] No access token, using default typeMaps');
          this._typeMap = DEFAULT_TYPE_MAP;
          this._colorStyleMap = DEFAULT_COLOR_STYLE_MAP;
          return;
        }

        const fetchTypeMappings = async (token) => chrome.runtime.sendMessage({
          type: 'ETSY_FETCH',
          payload: {
            url: `${apiUrl}/api/ecommerce/variant-type-mappings/`,
            options: {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            }
          }
        });

        let resp = await fetchTypeMappings(accessToken);

        // Token expired → refresh and retry once
        if (!resp?.ok && (resp?.status === 401 || resp?.data?.code === 'token_not_valid')) {
          try {
            const { refreshToken } = await chrome.storage.local.get('refreshToken');
            if (refreshToken) {
              const refreshResp = await chrome.runtime.sendMessage({
                type: 'ETSY_REFRESH_TOKEN',
                payload: { url: `${apiUrl}/api/token/refresh/`, refreshToken }
              });
              if (refreshResp?.ok && refreshResp?.accessToken) {
                await chrome.storage.local.set({ accessToken: refreshResp.accessToken });
                resp = await fetchTypeMappings(refreshResp.accessToken);
              }
            }
          } catch (refreshErr) {
            console.warn('[VH Scraper] Token refresh failed:', refreshErr);
          }
        }

        if (resp?.ok && resp?.data) {
          // Merge: defaults as base, API overrides on top
          this._typeMap = { ...DEFAULT_TYPE_MAP, ...(resp.data.typeMap || {}) };
          this._colorStyleMap = { ...DEFAULT_COLOR_STYLE_MAP, ...(resp.data.colorStyleMap || {}) };
          console.log('[VH Scraper] Loaded dynamic typeMaps from API:',
            Object.keys(this._typeMap).length, 'type mappings,',
            Object.keys(this._colorStyleMap).length, 'color-style mappings');
        } else {
          console.warn('[VH Scraper] API returned error, using defaults. Response:', resp);
          this._typeMap = DEFAULT_TYPE_MAP;
          this._colorStyleMap = DEFAULT_COLOR_STYLE_MAP;
        }
      } catch (err) {
        console.warn('[VH Scraper] Failed to load typeMaps from API, using defaults:', err);
        this._typeMap = DEFAULT_TYPE_MAP;
        this._colorStyleMap = DEFAULT_COLOR_STYLE_MAP;
      }
    }

    /**
     * Scrape all orders from the order list page
     * Selector: .panel-body-row
     */
    async scrapeOrderList() {
      const orders = [];

      await Utils.wait(500);

      // Find all order rows
      const orderRows = document.querySelectorAll('.panel-body-row');

      for (const row of orderRows) {
        try {
          const order = this.scrapeOrderRow(row);
          if (order && order.order_id) {
            const enrichedOrder = await this.enrichOrderWithDetails(row, order);
            orders.push(enrichedOrder);
          }
        } catch (e) {
          console.error('Error scraping order row:', e);
        }
      }

      return orders;
    }

    /**
     * Enrich order with details from detail panel
     */
    async enrichOrderWithDetails(row, order) {
      try {
        // Find and click the order link to open detail panel
        const orderLink = row.querySelector('a[href*="order_id="]');
        if (orderLink) {
          const expectedOrderNum = order.order_id.replace('ETSY-', '');

          const findPanel = () => {
            // Ưu tiên peek-overlay (panel phải) — tránh match panel danh sách bên trái
            const peek = document.querySelector('[class*="peek-overlay"]');
            if (peek) return peek;
            // Tìm WtTabPanel bên trong bất kỳ container nào (case-sensitive)
            const tabPanel = document.querySelector('[data-clg-id="WtTabPanel"]');
            if (tabPanel) return tabPanel.closest('.wt-overflow-y-scroll') || tabPanel;
            return document.querySelector('.order-details-panel') ||
                   document.querySelector('[role="dialog"]');
          };

          // If the panel already shows the right order, skip the click
          const existingPanel = findPanel();
          let panel = (existingPanel && existingPanel.textContent.includes(expectedOrderNum))
            ? existingPanel
            : null;

          if (!panel) {
            orderLink.click();

            // Poll until panel shows the correct order (max 4 seconds)
            for (let waited = 0; waited < 4000; waited += 300) {
              await Utils.wait(300);
              const p = findPanel();
              if (p && p.textContent.includes(expectedOrderNum)) {
                panel = p;
                break;
              }
            }
          }

          // Safety check: if panel still doesn't show this order, bail out
          if (!panel || !panel.textContent.includes(expectedOrderNum)) {
            console.warn(`[VH Scraper] Panel mismatch for order ${expectedOrderNum}, skipping enrichment`);
            return order;
          }

          // Get order creation date from panel
          const orderDescEl = panel.querySelector('[data-testid="order-description"]');
          const orderedText = orderDescEl ? orderDescEl.textContent : panel.textContent;
          const dateNewMatch = orderedText.match(/Ordered\s+(\d{1,2}:\d{2}(?:am|pm)),\s*\w+,\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
          if (dateNewMatch) {
            order.date_created = Utils.parseEtsyOrderedDate(dateNewMatch[1], dateNewMatch[2]);
          } else {
            const dateOldMatch = orderedText.match(/Ordered\s+([A-Za-z]{3}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/);
            if (dateOldMatch) order.date_created = Utils.formatDate(dateOldMatch[1]);
          }

          // Fetch earned revenue directly from Etsy earnings API (reliable, no stale DOM data)
          const earnedFromApi = await this.fetchEarnings(expectedOrderNum);
          if (earnedFromApi !== null) {
            order.revenue = earnedFromApi;
          }

          // Poll until address div is rendered (may lag behind order number by a render cycle)
          let addressDiv = null;
          const addressSelectors = [
            '.address.break-word.fs-mask',
            'div.address.fs-mask',
            '[class*="address"][class*="fs-mask"]',
            '.shipping-address',
            '[data-region="shipping-address"]'
          ];
          for (let waited = 0; waited < 2000; waited += 200) {
            for (const selector of addressSelectors) {
              const el = panel.querySelector(selector);
              if (el && el.querySelector('span.first-line, span.city')) {
                addressDiv = el;
                break;
              }
            }
            if (addressDiv) break;
            await Utils.wait(200);
          }
          // Fallback: any selector match even without spans
          if (!addressDiv) {
            for (const selector of addressSelectors) {
              addressDiv = panel.querySelector(selector);
              if (addressDiv) break;
            }
          }

          if (addressDiv) {
            const addressText = addressDiv.textContent;

            // Shipping name (may differ from Etsy account name — don't overwrite if already set)
            const nameEl = addressDiv.querySelector('span.name');
            if (nameEl) {
              order.customer_name = Utils.safeText(nameEl);
            }

            // Address line 1 from span.first-line
            const firstLineEl = addressDiv.querySelector('span.first-line');
            if (firstLineEl) {
              order.address_1 = Utils.safeText(firstLineEl);
            }

            // Address line 2 from span.second-line
            const secondLineEl = addressDiv.querySelector('span.second-line');
            if (secondLineEl) {
              order.address_2 = Utils.safeText(secondLineEl);
            }

            // City from span.city
            const cityEl = addressDiv.querySelector('span.city');
            if (cityEl) {
              order.city = Utils.safeText(cityEl);
            }

            // State from span.state
            const stateEl = addressDiv.querySelector('span.state');
            if (stateEl) {
              order.state = Utils.safeText(stateEl);
            }

            // Zipcode from span.zip
            const zipEl = addressDiv.querySelector('span.zip');
            if (zipEl) {
              order.zipcode = Utils.safeText(zipEl);
            }

            // Country from span.country-name
            const countryEl = addressDiv.querySelector('span.country-name');
            if (countryEl) {
              order.country = Utils.safeText(countryEl);
            }

            // Fallback: parse from text content
            if (!order.address_1 && !order.city) {
              const lines = addressText.split('\n').map(l => l.trim()).filter(l => l);

              if (lines.length >= 2) {
                let addressIdx = 0;
                if (order.customer_name && lines[0].includes(order.customer_name)) {
                  addressIdx = 1;
                }

                if (lines[addressIdx]) {
                  order.address_1 = lines[addressIdx];
                }

                const cityStateZip = lines[addressIdx + 1];
                if (cityStateZip) {
                  const match = cityStateZip.match(/^([^,]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?/);
                  if (match) {
                    order.city = match[1].trim();
                    order.state = match[2];
                    if (match[3]) order.zipcode = match[3];
                  }
                }

                const countryLine = lines[addressIdx + 2];
                if (countryLine && !countryLine.match(/^\d/)) {
                  order.country = countryLine;
                }
              }
            }

            // Extra fallback: if country still default, extract from last meaningful line of address text
            if (order.country === 'United States' && addressDiv) {
              const addrLines = addressDiv.textContent.split('\n').map(l => l.trim()).filter(l => l);
              for (let i = addrLines.length - 1; i >= 0; i--) {
                const line = addrLines[i];
                if (line && !line.startsWith('+') && !/^\d/.test(line) &&
                    line !== order.customer_name && line.length > 2 &&
                    !/^\d{3,5}\s+\w/.test(line)) {
                  order.country = line;
                  break;
                }
              }
            }

            // For non-US/CA/AU countries, state is not applicable
            const countriesRequiringState = ['United States', 'Canada', 'Australia', 'Brazil', 'Mexico', 'India'];
            if (!countriesRequiringState.includes(order.country)) {
              order.state = order.state || '';
            }
          }

          // Get item prices from table (same approach as scrapeOrderDetail: use cell index)
          const itemTable = panel.querySelector('table');
          if (itemTable && order.items.length > 0) {
            const rows = itemTable.querySelectorAll('tbody tr');
            let itemIndex = 0;
            rows.forEach((tr) => {
              if (tr.querySelector('th')) return;
              const cells = tr.querySelectorAll('td');
              if (cells.length >= 3 && order.items[itemIndex]) {
                const priceCell = cells[cells.length - 1];
                const priceText = Utils.safeText(priceCell);
                const priceMatch = priceText.match(/\$?([\d,.]+)/);
                if (priceMatch) {
                  order.items[itemIndex].price = parseFloat(priceMatch[1].replace(',', ''));
                  itemIndex++;
                }
              }
            });
          }
        }
      } catch (e) {
        console.error('Error enriching order:', e);
      }

      return order;
    }

    /**
     * Scrape single order row from .panel-body-row
     */
    scrapeOrderRow(row) {
      if (!row) return null;

      // Get shop name from URL or page header
      let shopName = 'Etsy Store';
      const urlMatch = window.location.href.match(/\/your\/shops\/([^\/]+)/);
      if (urlMatch) {
        shopName = decodeURIComponent(urlMatch[1]);
      } else {
        // Try to get from page header
        const shopHeader = document.querySelector('.shop-name, [data-shop-name], .wt-text-title-01');
        if (shopHeader) {
          shopName = Utils.safeText(shopHeader) || 'Etsy Store';
        }
      }

      const order = {
        platform: 'Etsy',
        shop_name: shopName,
        order_id: null,
        customer_name: '',
        email: '',
        address_1: '',
        address_2: '',
        city: '',
        state: '',
        country: 'United States',
        zipcode: '',
        phone_number: '',
        note: '',
        revenue: null,
        shipping_cost: null,
        status: 'PENDING',
        items: [],
        date_created: null,
        ship_by: null
      };

      // === ORDER ID ===
      // From: a[href*="order_id="] like "#3921781860"
      const orderIdLink = row.querySelector('a[href*="order_id="]');
      if (orderIdLink) {
        const idMatch = Utils.safeText(orderIdLink).match(/#?(\d+)/);
        if (idMatch) {
          order.order_id = `ETSY-${idMatch[1]}`;
        }
      }

      // Fallback: from checkbox name
      if (!order.order_id) {
        const checkbox = row.querySelector('input[type="checkbox"][name]');
        if (checkbox?.name) {
          order.order_id = `ETSY-${checkbox.name}`;
        }
      }

      // === CUSTOMER NAME ===
      // From: button.btn-link [data-test-id="unsanitize"]
      const customerBtn = row.querySelector('button.btn-link[data-dropdown-button]');
      if (customerBtn) {
        order.customer_name = Utils.getUnsanitizedText(customerBtn) || Utils.safeText(customerBtn);
      }

      // === EMAIL ===
      // From: a[href^="mailto:"]
      const emailLink = row.querySelector('a[href^="mailto:"]');
      if (emailLink) {
        order.email = emailLink.href.replace('mailto:', '').trim();
      }

      // === PRICE/REVENUE ===
      // Look for price in multiple locations
      const priceSpan = row.querySelector('.col-xs-5 .mr-xs-1, .hide-xs .mr-xs-1');
      if (priceSpan) {
        const priceMatch = Utils.safeText(priceSpan).match(/\$[\d,.]+/);
        if (priceMatch) {
          const { amount } = Utils.parsePrice(priceMatch[0]);
          order.revenue = amount;
        }
      }

      // Fallback: search in text
      if (!order.revenue) {
        const allPrices = row.textContent.match(/\$[\d,.]+/g);
        if (allPrices && allPrices.length > 0) {
          // First price is usually the order total
          const { amount } = Utils.parsePrice(allPrices[0]);
          order.revenue = amount;
        }
      }

      // === SHIPPING COST ===
      // From: "Standard Shipping ($5.50)"
      const shippingMatch = row.textContent.match(/Shipping\s*\(\$?([\d,.]+)\)/i);
      if (shippingMatch) {
        order.shipping_cost = parseFloat(shippingMatch[1]);
      }

      // === SHIP BY DATE ===
      // From: "Ship by Dec 29, 2025"
      const shipByMatch = row.textContent.match(/Ship by\s+([A-Za-z]{3}\s+\d{1,2},?\s*\d{4})/);
      if (shipByMatch) {
        order.ship_by = Utils.formatDate(shipByMatch[1]);
      }

      // === ORDER DATE ===
      // New format: "Ordered 2:02am, Tue, May 5, 2026"
      const orderedNewMatch = row.textContent.match(/Ordered\s+(\d{1,2}:\d{2}(?:am|pm)),\s*\w+,\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
      if (orderedNewMatch) {
        order.date_created = Utils.parseEtsyOrderedDate(orderedNewMatch[1], orderedNewMatch[2]);
      }
      // Old format: "Ordered Dec 24, 2025" or "Ordered 12/24/2025"
      if (!order.date_created) {
        const orderedMatch = row.textContent.match(/Ordered\s+([A-Za-z]{3}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/);
        if (orderedMatch) order.date_created = Utils.formatDate(orderedMatch[1]);
      }

      // === SHIPPING ADDRESS ===
      // Try multiple selectors for address
      // 1. From address div with fs-mask class
      const addressDiv = row.querySelector('.address.break-word.fs-mask, div.address.fs-mask');
      if (addressDiv) {
        // Customer name
        const nameEl = addressDiv.querySelector('span.name, .name');
        if (nameEl && !order.customer_name) {
          order.customer_name = Utils.safeText(nameEl);
        }

        // Address line 1 (first-line)
        const firstLineEl = addressDiv.querySelector('span.first-line, .first-line');
        if (firstLineEl) {
          order.address_1 = Utils.safeText(firstLineEl);
        }

        // City
        const cityEl = addressDiv.querySelector('span.city, .city');
        if (cityEl) {
          order.city = Utils.safeText(cityEl);
        }

        // State
        const stateEl = addressDiv.querySelector('span.state, .state');
        if (stateEl) {
          order.state = Utils.safeText(stateEl);
        }

        // Zipcode
        const zipEl = addressDiv.querySelector('span.zip, .zip');
        if (zipEl) {
          order.zipcode = Utils.safeText(zipEl);
        }

        // Country
        const countryEl = addressDiv.querySelector('span.country-name, .country-name');
        if (countryEl) {
          order.country = Utils.safeText(countryEl);
        }
      }

      // Fallback: parse from "Ship to City, State" text
      // Only set state if the 2-letter code is a real US/CA state (not a country ISO code like FR, GB, DE)
      const US_CA_STATES = new Set([
        'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY',
        'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND',
        'OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
        'PR','GU','VI','AS','MP',
        'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'
      ]);
      if (!order.city) {
        const shipToMatch = row.textContent.match(/Ship to\s+([^,]+),\s*([A-Z]{2})/i);
        if (shipToMatch) {
          order.city = shipToMatch[1].trim();
          const code = shipToMatch[2].toUpperCase();
          if (US_CA_STATES.has(code)) {
            order.state = code;
          }
          // Non-US/CA codes (FR, GB, DE...) are country codes, not states — ignore
        }
      }

      // If country still default, try extracting from address div text (last meaningful line)
      if (order.country === 'United States' && addressDiv) {
        const addrLines = addressDiv.textContent.split('\n').map(l => l.trim()).filter(l => l);
        for (let i = addrLines.length - 1; i >= 0; i--) {
          const line = addrLines[i];
          if (line && !line.startsWith('+') && !/^\d/.test(line) &&
              line !== order.customer_name && line.length > 2 &&
              !/^\d{3,5}\s+\w/.test(line)) {
            order.country = line;
            break;
          }
        }
      }

      // === ITEMS ===
      // From: .flag.mt-xs-2 elements containing product info
      const itemFlags = row.querySelectorAll('.flag.mt-xs-2');
      itemFlags.forEach(flag => {
        const item = this.scrapeOrderItem(flag);
        if (item) {
          order.items.push(item);
        }
      });

      return order;
    }

    /**
     * Scrape single order item from .flag element
     */
    scrapeOrderItem(flagEl) {
      if (!flagEl) return null;

      const item = {
        sku: '',
        sku_name: '',  // Will be built from Shirt size + Shirt Colors
        name: '',
        quantity: 1,
        price: null,
        image_url: '',
        product_url: '',
        variations: {},
        personalization: ''
      };

      // === PRODUCT URL & TITLE ===
      // From: a[href*="/transaction/"]
      const productLink = flagEl.querySelector('a[href*="/transaction/"]');
      if (productLink) {
        item.product_url = productLink.href;
        // Use title attribute first (full title), fallback to textContent
        item.name = productLink.title || Utils.safeText(productLink) || '';

        const skuMatch = productLink.href.match(/\/transaction\/(\d+)/);
        if (skuMatch) {
          item.sku = skuMatch[1];
        }
      }

      // Fallback name from [data-test-id="unsanitize"]
      if (!item.name) {
        // Try link text content first
        const linkText = flagEl.querySelector('a[data-test-id="unsanitize"], .flag-body a');
        if (linkText) {
          item.name = Utils.safeText(linkText);
        }
      }
      if (!item.name) {
        const nameEl = flagEl.querySelector('.flag-body [data-test-id="unsanitize"]');
        if (nameEl) {
          item.name = Utils.safeText(nameEl);
        }
      }

      // === IMAGE ===
      const imgEl = flagEl.querySelector('img.rounded');
      if (imgEl) {
        // Convert thumbnail (75x75) to larger size (300x300)
        let imgUrl = imgEl.src;
        if (imgUrl.includes('il_75x75')) {
          imgUrl = imgUrl.replace('il_75x75', 'il_300x300');
        } else if (imgUrl.includes('il_170x135')) {
          imgUrl = imgUrl.replace('il_170x135', 'il_300x300');
        }
        item.image_url = imgUrl;
      }

      // === ITEM PRICE ===
      // Try multiple selectors for price in item row
      // 1. From span with price pattern in flag-body
      const flagBody = flagEl.querySelector('.flag-body');
      if (flagBody) {
        // Look for price patterns like "$37.92" or "US$ 37.92"
        const priceEls = flagBody.querySelectorAll('span, div');
        for (const el of priceEls) {
          const text = Utils.safeText(el);
          const priceMatch = text.match(/^\s*(?:US)?\s*\$\s*([\d,.]+)\s*$/);
          if (priceMatch) {
            item.price = parseFloat(priceMatch[1].replace(',', ''));
            break;
          }
        }
      }

      // 2. Look for price in any descendant with price pattern
      if (!item.price) {
        const allText = flagEl.textContent;
        // Find all prices but exclude shipping costs
        const priceMatches = allText.match(/(?<!Shipping\s*\()\$\s*([\d,.]+)/g);
        if (priceMatches && priceMatches.length > 0) {
          // First price is usually item price
          const firstPrice = priceMatches[0].match(/\$\s*([\d,.]+)/);
          if (firstPrice) {
            item.price = parseFloat(firstPrice[1].replace(',', ''));
          }
        }
      }

      // === QUANTITY ===
      // From: li containing "Quantity" and span.strong
      const qtyLi = Array.from(flagEl.querySelectorAll('li')).find(li =>
        li.textContent.includes('Quantity')
      );
      if (qtyLi) {
        const qtyVal = qtyLi.querySelector('.strong');
        if (qtyVal) {
          item.quantity = parseInt(Utils.safeText(qtyVal)) || 1;
        }
      }

      // === VARIATIONS ===
      // Try multiple selectors for variations
      let variationLis = flagEl.querySelectorAll('li.clearfix');

      // If no li.clearfix, try ul.list-unstyled > li
      if (variationLis.length === 0) {
        const listUnstyled = flagEl.querySelector('ul.list-unstyled');
        if (listUnstyled) {
          variationLis = listUnstyled.querySelectorAll('li');
        }
      }

      // Also try span.mb-xs-1 > ul.list-unstyled > li (based on screenshot)
      if (variationLis.length === 0) {
        const mbSpan = flagEl.querySelector('span.mb-xs-1');
        if (mbSpan) {
          variationLis = mbSpan.querySelectorAll('ul.list-unstyled > li');
        }
      }

      // Last resort: grab ALL li in flag, skip the Quantity one
      if (variationLis.length === 0) {
        variationLis = Array.from(flagEl.querySelectorAll('li')).filter(li =>
          !li.textContent.includes('Quantity')
        );
      }

      variationLis.forEach(li => {
        // Method 1: Try label + value pattern (li.clearfix style)
        const labelEl = li.querySelector('.text-gray-lighter');
        const valueEl = li.querySelector('.strong');

        if (labelEl && valueEl) {
          const label = Utils.safeText(labelEl);
          const value = Utils.normalizeVariationValue(Utils.safeText(valueEl));

          if (label && value && label !== 'Quantity') {
            item.variations[label] = value;
          }
        } else {
          // Method 2: Get from span[data-test-id="unsanitize"] (new structure)
          const unsanitizeSpan = li.querySelector('span[data-test-id="unsanitize"]');
          if (unsanitizeSpan) {
            const text = Utils.safeText(unsanitizeSpan);
            if (text) {
              // Get the label from preceding span if exists
              const labelSpan = li.querySelector('span:not([data-test-id])');
              if (labelSpan) {
                const labelText = Utils.safeText(labelSpan);
                if (labelText) {
                  item.variations[labelText.replace(':', '').trim()] = Utils.normalizeVariationValue(text);
                } else {
                  // No label, use index
                  const idx = Object.keys(item.variations).length + 1;
                  item.variations[`Option ${idx}`] = Utils.normalizeVariationValue(text);
                }
              } else {
                // Parse "Label: Value" pattern from text itself
                if (text.includes(':')) {
                  const [label, ...valueParts] = text.split(':');
                  item.variations[label.trim()] = Utils.normalizeVariationValue(valueParts.join(':').trim());
                } else {
                  const idx = Object.keys(item.variations).length + 1;
                  item.variations[`Option ${idx}`] = Utils.normalizeVariationValue(text);
                }
              }
            }
          } else {
            // Method 3: text content — colon separator ("Label: Value")
            const liText = Utils.safeText(li);
            if (liText && liText.includes(':')) {
              const [label, ...valueParts] = liText.split(':');
              const labelClean = label.trim();
              const valueClean = valueParts.join(':').trim();
              if (labelClean && valueClean && labelClean !== 'Quantity') {
                item.variations[labelClean] = Utils.normalizeVariationValue(valueClean);
              }
            } else if (liText) {
              // Method 4: known-label prefix without colon ("Type  Premium Embroidery")
              const KNOWN_LABELS = ['Type', 'Hat Type', 'Product Type', 'Style and Size', 'Style', 'Size', 'Sizes', 'Color', 'Colors',
                'Shirt size', 'Unisex shirt size', 'Shirt Colors', 'Design', 'Option', 'SKU', 'Personalization'];
              for (const lbl of KNOWN_LABELS) {
                if (liText.startsWith(lbl) && liText.length > lbl.length) {
                  const val = liText.slice(lbl.length).replace(/^[\s:]+/, '').trim();
                  if (val && val !== 'Quantity') {
                    item.variations[lbl] = Utils.normalizeVariationValue(val);
                    break;
                  }
                }
              }
            }
          }
        }
      });

      // === PERSONALIZATION ===
      // Extract personalization from variations if present
      // 1. Match by key name "Personalization"
      let notRequestedPersonalization = false;
      const personalizationKey = Object.keys(item.variations).find(k => /^personalization$/i.test(k));
      if (personalizationKey) {
        const pVal = item.variations[personalizationKey];
        if (pVal && !/not requested/i.test(pVal)) {
          item.personalization = pVal;
        } else if (pVal && /not requested/i.test(pVal)) {
          notRequestedPersonalization = true;
        }
        delete item.variations[personalizationKey];
      }
      // 2. Also remove any variation whose VALUE contains personalization boilerplate
      //    e.g. Option 2 = "Personalization Not requested on this item."
      for (const [key, value] of Object.entries(item.variations)) {
        if (/personalization/i.test(value)) {
          if (!/not requested/i.test(value)) {
            item.personalization = item.personalization || value.replace(/^personalization[:\s]*/i, '').trim();
          } else {
            notRequestedPersonalization = true;
          }
          delete item.variations[key];
        }
      }

      // 3. Treat CUSTOM variation key as personalization (e.g. Acrylic Keychain 2 side orders)
      const customKey = Object.keys(item.variations).find(k => /^custom$/i.test(k));
      if (customKey) {
        const customVal = item.variations[customKey];
        if (customVal && !item.personalization) item.personalization = customVal;
        delete item.variations[customKey];
      }

      // === BUILD SKU_NAME from variations ===
      // Example: "T-shirt - M, Black"
      const skuParts = [];

      // Priority order for sku_name (expanded list)
      const priorityKeys = [
        'Style and Size', 'Type-Size', 'Type - Size', 'Type', 'Sizes', 'Size', 'Shirt size', 'Unisex shirt size',
        'Color', 'Colors', 'Shirt Colors',
        'Style', 'Design', 'Option', 'Option 1', 'Option 2'
      ];

      for (const key of priorityKeys) {
        if (item.variations[key]) {
          skuParts.push(item.variations[key]);
        }
      }

      // If no priority keys found, use all variations
      if (skuParts.length === 0) {
        for (const [key, value] of Object.entries(item.variations)) {
          skuParts.push(value);
        }
      }

      // Also include values from unknown variation keys not already in skuParts
      // (e.g. "Unisex Ringer T-Shirt": "XL" where key is not a known priority key)
      const priorityKeySet = new Set(priorityKeys);
      for (const [key, value] of Object.entries(item.variations)) {
        if (!priorityKeySet.has(key) && !skuParts.includes(value)) {
          skuParts.unshift(value);
        }
      }

      item.sku_name = skuParts.join(', ');

      // Append personalization to sku_name if present
      if (item.personalization) {
        item.sku_name += `, Personalization: ${item.personalization}`;
      }

      // Append "Not requested this on item" to sku when personalization was not requested
      if (notRequestedPersonalization) {
        item.sku += (item.sku ? ', ' : '') + 'Not requested this on item';
      }

      // Normalize typography characters in item name (curly apostrophes, etc.)
      item.name = Utils.normalizeText(item.name);

      // === PARSE VARIANTS (size, color, product_type, brightness) ===
      console.log('[VH DEBUG] variations:', JSON.stringify(item.variations));
      item.parsed_variants = this.parseVariants(item.variations, item.name);
      console.log('[VH DEBUG] parsed_variants:', JSON.stringify(item.parsed_variants));

      return item;
    }

    /**
     * Parse variations to standard variants format
     * @param {Object} variations - Raw variations from Etsy
     * @param {string} itemName - Product name for context
     * @returns {Object} - {size, color, product_type, brightness}
     */
    parseVariants(variations, itemName = '') {
      let size = '';
      let color = '';
      let product_type = '';
      let brightness = 'light';

      const darkColors = ['black', 'navy', 'dark', 'charcoal', 'brown', 'maroon', 'forest', 'purple', 'royal', 'pepper'];

      // Case-insensitive variation value getter
      const getVar = (key) => {
        if (variations[key] !== undefined) return variations[key];
        const lower = key.toLowerCase();
        for (const [k, v] of Object.entries(variations)) {
          if (k.toLowerCase() === lower) return v;
        }
        return '';
      };

      // Use dynamic mappings loaded from API (with hardcoded fallback)
      const typeMap = this._typeMap || {
        'T-Shirt': 'T-shirt', 'TShirt': 'T-shirt', 'Hoodie': 'Hoodie', 'Sweatshirt': 'Sweatshirt',
        'Comfort TShirt': 'Comfort colors t-shirt',
        'Comfort T-shirt': 'Comfort colors t-shirt',
        'Comfort Colors': 'Comfort colors t-shirt',
        'Comfort': 'Comfort colors t-shirt',
        'Wash T-shirt': 'Mineral Wash Colortone 1300',
        'Tough Cases (iPhone)': 'Tough Cases (iPhone)',
        'Football Jersey': '3D-VN  Mesh football jersey',
        'Mesh Football Jersey': '3D-VN  Mesh football jersey',
        'Baseball Jersey': '3D-VN PREMIUM BASEBALL JERSEY (BORDERS)',
        'Kid Jersey': '3D-VN Kid Youth Baseball Jersey Border',
        'Croptop Football': '3D-VN All-Over Print Mesh Football Crop Top Jersey',
        'AOP Mesh FB Crop Top Jersey': '3D-VN All-Over Print Mesh Football Crop Top Jersey',
        'AOP Player Football Jersey': '3D-VN All Over Print Player Football Jersey',
        'AOP Lace Neck Hockey Jersey': '3D-VN MF All-over Print Lace Neck Hockey Jersey',
        'AOP Hockey Jersey': '3D-VN MF All-over Print Hockey Jersey',
        'AOP V-Neck Hockey Jersey': '3D-VN AOP V-Neck Hockey Jersey',
        'AOP Seamless': '3D-VN All-Over Print Seamless Sleeve T-shirt',
        'Polo Men Shirt': '3D-VN All Over Print Men Polo Premium Shirt',
        'Polo Women Shirt': '3D-VN All Over Print Women Polo Premium Shirt',
        'Die Sticker': 'Die-cut Stickers US 2',
        'Kiss Sticker': 'Kiss-cut Stickers US 2',
        'Poster': 'Premium Luster Photo Paper Poster US 2',
        'Ceramic Mug': 'Ceramic Mug US 2',
        'Accent Mug': 'Accent Mug US 2',
        'Acrylic Keychain': 'Acrylic Keychain US',
        'Keychain 2 Side': 'Acrylic Keychain 2 side US',
        'Keychain 2side': 'Acrylic Keychain 2 side US',
        '2 Side Keychain': 'Acrylic Keychain 2 side US',
        '2Side Keychain': 'Acrylic Keychain 2 side US',
        'Suncatcher': 'Window Hanging Suncatcher Ornaments 1 layer US',
        'Normal Shirt': '3D-VN US HAWAIIAN SHIRT',
        'Hawaiian Shirt': '3D-VN US HAWAIIAN SHIRT',
        'Classic Dad Hat': 'Classic Dad Hat',
        'Premium Embroidery': 'Classic Dad Hat',
        'Classic Printed': 'Classic Dad Hat',
        'Baseball Hat': 'Baseball Hat',
        'Embroidery Baseball Hat': 'Baseball Hat',
        'Trucker Hat': 'Trucker Hat',
        'Double Printed Flag': '3D-VN USA Polyester and Double Printed Flag',
        '3D Printed Flag': '3D-VN USA Polyester and Double Printed Flag',
        'Flag': '3D-VN USA Polyester and Double Printed Flag',
        'Greeting Card': 'Greetingcard',
        'Card': 'Greetingcard',
      };
      const colorStyleMap = this._colorStyleMap || {};
      // Mug product definitions (color + size constraints)
      const mugProducts = [
        {
          name: 'Ceramic Mug US 2',
          color: ['Black', 'White'],
          size: ['11oz', '15oz'],
        },
        {
          name: 'Accent Mug US 2',
          color: ['Light Blue', 'Light Pink', 'Red', 'Black'],
          size: ['11oz'],
        },
      ];
      const keychainProduct = {
        name: 'Acrylic Keychain US',
        color: ['Default'],
        size: ["2''", "3''", "4''"],
      };
      const keychain2SideProduct = {
        name: 'Acrylic Keychain 2 side US',
        color: ['Default'],
        size: ["2''", "3''", "4''"],
      };
      const oneSizeProductTypes = new Set(['Classic Dad Hat', 'Baseball Hat', 'Trucker Hat']);

      const toughCasesIphone = {
        name: 'Tough Cases (iPhone)',
        size: [
          'iPhone 7 / 8 / SE',
          'iPhone 7 Plus / 8 Plus',
          'iPhone X / XS',
          'iPhone XR',
          'iPhone XS Max',
          'iPhone 11',
          'iPhone 11 Pro',
          'iPhone 11 Pro Max',
          'iPhone 12 / 12 Pro',
          'iPhone 12 Pro Max',
          'iPhone 12 Mini / 13 Mini',
          'iPhone 13 / 14',
          'iPhone 13 Pro',
          'iPhone 13 Pro Max',
          'iPhone 14 Pro',
          'iPhone 14 Pro Max',
          'iPhone 14 Plus',
          'iPhone 15',
          'iPhone 15 Pro',
          'iPhone 15 Pro Max',
          'iPhone 15 Plus',
          'iPhone 16',
          'iPhone 16 Pro',
          'iPhone 16 Pro Max',
          'iPhone 16 Plus',
          'iPhone 16 E',
          'iPhone 17',
          'iPhone 17 Air',
          'iPhone 17 Pro',
          'iPhone 17 Pro Max'
        ]
      };
      const toughCasesIphoneSizeMap = {
        'iPhone 7 / 8 / SE': 'iPhone 7/8/SE',
        'iPhone 7 Plus / 8 Plus': 'iPhone 7+/8+',
        'iPhone X / XS': 'iPhone X/XS',
        'iPhone XR': 'iPhone XR',
        'iPhone XS Max': 'iPhone XS Max',
        'iPhone 11': 'iPhone 11',
        'iPhone 11 Pro': 'iPhone 11 Pro',
        'iPhone 11 Pro Max': 'iPhone 11 Pro Max',
        'iPhone 12 / 12 Pro': 'iPhone 12/12 Pro',
        'iPhone 12 Pro Max': 'iPhone 12 Pro Max',
        'iPhone 12 Mini / 13 Mini': 'iPhone 12/13 Mini',
        'iPhone 13 / 14': 'iPhone 13/14',
        'iPhone 13 Pro': 'iPhone 13 Pro',
        'iPhone 13 Pro Max': 'iPhone 13 Pro Max',
        'iPhone 14 Pro': 'iPhone 14 Pro',
        'iPhone 14 Pro Max': 'iPhone 14 Pro Max',
        'iPhone 14 Plus': 'iPhone 14 Plus',
        'iPhone 15': 'iPhone 15',
        'iPhone 15 Pro': 'iPhone 15 Pro',
        'iPhone 15 Pro Max': 'iPhone 15 Pro Max',
        'iPhone 15 Plus': 'iPhone 15 Plus',
        'iPhone 16': 'iPhone 16',
        'iPhone 16 Pro': 'iPhone 16 Pro',
        'iPhone 16 Pro Max': 'iPhone 16 Pro Max',
        'iPhone 16 Plus': 'iPhone 16 Plus',
        'iPhone 16 E': 'iPhone 16 E',
        'iPhone 17': 'iPhone 17',
        'iPhone 17 Air': 'iPhone 17 Air',
        'iPhone 17 Pro': 'iPhone 17 Pro',
        'iPhone 17 Pro Max': 'iPhone 17 Pro Max'
      };
      const normalizeToughCasesIphoneSize = (rawSize) => {
        if (!rawSize) return rawSize;
        const normalized = toughCasesIphoneSizeMap[rawSize] || rawSize;
        // Etsy option name max length is 20 chars.
        return normalized.length <= 20 ? normalized : normalized.slice(0, 20);
      };
      const normalizeMugSize = (rawSize) => {
        if (!rawSize) return rawSize;
        const match = rawSize.match(/^(\d+)\s*oz$/i);
        if (match) {
          return `${match[1]}oz`;
        }
        return rawSize.replace(/\s+/g, '').toLowerCase();
      };

      // Normalize common size aliases to canonical form
      const normalizeSize = (s) => {
        if (!s) return s;
        const upper = s.toUpperCase().trim();
        const aliases = { 'XXL': '2XL', 'XXXL': '3XL', 'XXXXL': '4XL', 'XXXXXL': '5XL' };
        return aliases[upper] || upper;
      };

      // Case-insensitive typeMap lookup: exact first, then case-insensitive, then partial
      const lookupType = (rawType) => {
        if (!rawType) return '';
        // Normalize "Tshirt"/"TShirt"/"tshirt" → "T-Shirt" so hyphen-less variants always match
        if (/^t-?shirt$/i.test(rawType)) rawType = 'T-Shirt';
        if (typeMap[rawType]) return typeMap[rawType];
        const lower = rawType.toLowerCase();
        for (const [key, val] of Object.entries(typeMap)) {
          if (key.toLowerCase() === lower) return val;
        }
        // Partial match: only when rawType is LONGER and contains the key as a word
        // e.g. "Mesh Football Jersey" (rawType) matches "Football Jersey" (key)
        // but "TShirt" (rawType) does NOT match "Comfort TShirt" (key) — rawType is shorter
        for (const [key, val] of Object.entries(typeMap)) {
          if (lower.length >= key.length && lower.includes(key.toLowerCase())) return val;
        }
        // Strip size suffix from API keys and compare
        // e.g. rawType="AOP Mesh FB CTJ" matches key="AOP Mesh FB CTJ - M" after stripping " - M"
        for (const [key, val] of Object.entries(typeMap)) {
          const keyBase = key.replace(/\s+-\s*(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)\s*$/i, '').trim();
          if (keyBase.toLowerCase() === lower) return val;
        }
        return rawType;
      };

      // === Handle "Style and Size" format ===
      // Example: "Unisex T-shirt XL" -> size="XL", product_type="T-shirt"
      const styleAndSize = getVar('Style and Size');
      if (styleAndSize) {
        const sizeMatch = styleAndSize.match(/\b(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)\s*$/i);
        if (sizeMatch) {
          size = normalizeSize(sizeMatch[1]);
          let typePart = styleAndSize.substring(0, sizeMatch.index).trim();
          // Remove "Unisex" prefix
          typePart = typePart.replace(/^Unisex\s+/i, '').trim();
          product_type = lookupType(typePart);
        }
      }

      // === Handle "Style" format ===
      // Example: "T-Shirt - M" -> size="M", product_type="T-shirt"
      const styleVariation = getVar('Style');
      if (!size && styleVariation && styleVariation.includes(' - ')) {
        const parts = styleVariation.split(' - ');
        if (parts.length >= 2) {
          const rawType = parts[0].trim();
          const rawSize = parts[1].trim();
          if (/^(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)$/i.test(rawSize)) {
            size = normalizeSize(rawSize);
            if (!product_type) {
              product_type = lookupType(rawType);
            }
          }
        }
      }

      // === Pre-resolve "Product Type" variation ===
      // Must run before shirtSize/typeVariation blocks so product_type is locked before their guards run.
      if (!product_type) {
        const productTypeVar = getVar('Product Type');
        if (productTypeVar) {
          const mapped = lookupType(productTypeVar);
          const lower = productTypeVar.toLowerCase();
          const isKnown = Object.keys(typeMap).some(k => k.toLowerCase() === lower);
          if (isKnown || mapped.toLowerCase() !== lower) {
            product_type = mapped;
          }
        }
      }

      // === Handle "Shirt size" / "Unisex shirt size" format ===
      // Example: "Hoodie - 2XL" -> size="2XL", product_type="Hoodie"
      const shirtSize = getVar('Shirt size') || getVar('Unisex shirt size') || getVar('Sizes') || getVar('Size');
      if (!size && shirtSize && shirtSize.includes(' - ')) {
        const parts = shirtSize.split(' - ');
        if (parts.length >= 2) {
          const rawType = parts[0].trim();
          const rawSizeVal = parts[1].trim();
          // Handle "2Side - Ninch" → Acrylic Keychain 2 side US
          if (/^2\s*side$/i.test(rawType) && /^(\d+)\s*inch?s?$/i.test(rawSizeVal)) {
            const inchNum = rawSizeVal.match(/^(\d+)/)[1];
            size = `${inchNum}''`;
            product_type = keychain2SideProduct.name;
          } else {
            // Normalize bare inch-mark: "3"" → "3''"
            const bareInchMatch = rawSizeVal.match(/^(\d+)\s*"$/);
            size = bareInchMatch ? `${bareInchMatch[1]}''` : rawSizeVal;
            if (!product_type) {
              product_type = lookupType(rawType);
            }
          }
        }
      }
      
      // === Handle "SIZE TYPE" format (fallback) ===
      // Example: "S Croptop Football" -> size="S", product_type="Croptop Football"
      // Example: "M Football Jersey"  -> size="M", product_type="Football Jersey"
      if (!size && shirtSize) {
        const sizeTypeMatch = shirtSize.match(/^(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)\s+(.+)$/i);
        if (sizeTypeMatch) {
          size = normalizeSize(sizeTypeMatch[1]);
          const rawType = sizeTypeMatch[2].trim();
          if (!product_type) {
            product_type = lookupType(rawType);
          }
        }
      }

      // Plain size value with no type prefix: "XL", "2XL", "S", etc.
      if (!size && shirtSize && /^(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)$/i.test(shirtSize)) {
        size = normalizeSize(shirtSize);
      }

      // === Handle "Type-Size" format ===
      // Example: "Hoodie-2XL" -> size="2XL", product_type="Hoodie"
      const typeSize = getVar('Type-Size') || getVar('Type - Size');
      if (!size && typeSize) {
        const lastHyphen = typeSize.lastIndexOf('-');
        if (lastHyphen > 0) {
          const rawType = typeSize.substring(0, lastHyphen).trim();
          const rawSize = typeSize.substring(lastHyphen + 1).trim();
          if (/^(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)$/i.test(rawSize)) {
            size = normalizeSize(rawSize);
            if (!product_type) {
              product_type = lookupType(rawType);
            }
          }
        }
      }

      // === Handle "Type" / "Hat Type" format ===
      // Example: "Wash T-shirt - 2XL" -> size="2XL", product_type="Mineral Wash Colortone 1300"
      // Example: "Die Sticker - 2"x2"" -> size="2''x2''", product_type="Die-cut Stickers US 2"
      // Example: "Die Sticker -2"x2"" -> size="2''x2''", product_type="Die-cut Stickers US 2"
      // Example: "Poster - 8x12" -> size="8''x12''", product_type="Premium Luster Photo Paper Poster US 2"
      // Example: Hat Type="Trucker Hat" or "Classic Dad Hat"
      const typeVariation = getVar('Type') || getVar('Hat Type') || getVar('Product Type');
      if (!size && typeVariation) {
        // Flexible separator: " - " or " -" (with or without trailing space)
        const typeMatch = typeVariation.match(/^(.+?)\s+-\s*(.+)$/);
        if (typeMatch) {
          const rawType = typeMatch[1].trim();
          const rawSize = typeMatch[2].trim();

          // Check garment size first (S, M, L, XL, 2XL, etc.)
          if (/^(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)$/i.test(rawSize)) {
            size = normalizeSize(rawSize);
          }
          // Check youth/kid sizes (2T, 3T, 4T, 6Y, 8Y, 10Y, S(-12Y-), M(-14Y-), L(-16-), etc.)
          else if (/^(\d+T|\d+Y|[SML]\(-\d+Y?-\))$/i.test(rawSize)) {
            size = rawSize;
          }
          // Check dimension size: 3x3, 8x12, 2"x2", 4"x4" (straight or curly inch marks, or '' two single quotes)
          else {
            const dimMatch = rawSize.match(/^(\d+)\s*(?:["\u201C\u201D\u2033]|'{1,2}|\s*in)?\s*[x\u00D7]\s*(\d+)\s*(?:["\u201C\u201D\u2033]|'{1,2}|\s*in)?$/i);
            if (dimMatch) {
              size = `${dimMatch[1]}''x${dimMatch[2]}''`;
              color = color || 'Default';
            } else {
              // Single-inch size: 6'', 8'', 10'', 12'' (suncatcher, ornaments, etc.)
              const singleInchMatch = rawSize.match(/^(\d+)\s*(?:inches?|in|["“”″]|'{1,2})?$/i);
              if (singleInchMatch) {
                size = `${singleInchMatch[1]}''`;
                color = color || 'Default';
              }
            }
          }

          if (size && !product_type) {
            product_type = lookupType(rawType);
          }
        }

        // Fallback: handle "Type" with no space before hyphen, e.g. "TShirt-XL"
        if (!size) {
          const lastHyphen = typeVariation.lastIndexOf('-');
          if (lastHyphen > 0) {
            let rawType = typeVariation.substring(0, lastHyphen).trim();
            const rawSize = typeVariation.substring(lastHyphen + 1).trim();
            if (/^(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)$/i.test(rawSize)) {
              size = normalizeSize(rawSize);
              // Normalize "TShirt" -> "T-Shirt" (add hyphen)
              if (/^tshirt$/i.test(rawType)) rawType = 'T-Shirt';
              if (!product_type) {
                product_type = lookupType(rawType);
              }
            }
          }
        }

        // Fallback: handle comma separator, e.g. "T-Shirt, M"
        if (!size) {
          const lastComma = typeVariation.lastIndexOf(',');
          if (lastComma > 0) {
            const rawType = typeVariation.substring(0, lastComma).trim();
            const rawSize = typeVariation.substring(lastComma + 1).trim();
            if (/^(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)$/i.test(rawSize)) {
              size = normalizeSize(rawSize);
              if (!product_type) {
                product_type = lookupType(rawType);
              }
            }
          }
        }
      }

      // === Fallback: variation KEY is the product type name, VALUE is the garment size ===
      // Example: { "Unisex Ringer T-Shirt": "XL" } — Etsy uses the variation group name as the label
      if (!size) {
        const knownSizeKeys = new Set([
          'Style and Size', 'Type-Size', 'Type - Size', 'Type', 'TYPE', 'Hat Type', 'Sizes', 'Size', 'SIZE',
          'Shirt size', 'Unisex shirt size', 'Style', 'Color', 'Colors', 'Shirt Colors',
          'Design', 'DESIGN', 'Option', 'Option 1', 'Option 2', 'SKU', 'Personalization',
          'Product Type'
        ]);
        for (const [key, val] of Object.entries(variations)) {
          if (knownSizeKeys.has(key)) continue;
          if (/^(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)$/i.test(val)) {
            size = normalizeSize(val);
            if (!product_type) {
              product_type = lookupType(key.replace(/^Unisex\s+/i, '').trim());
            }
            break;
          }
        }
      }

      // === Handle Mug format ===
      // Example: Type="Ceramic Mug - 11oz", Color="Black" -> product_type="Ceramic Mug US 2"
      if (!product_type && typeVariation) {
        const mugTypeMatch = typeVariation.match(/^(.+?)\s+-\s*(.+)$/);
        if (mugTypeMatch) {
          const rawMugType = mugTypeMatch[1].trim();
          const rawMugSize = mugTypeMatch[2].trim();
          const normalizedMugSize = normalizeMugSize(rawMugSize);
          const matchedMug = mugProducts.find((m) => m.name === lookupType(rawMugType));
          if (matchedMug && matchedMug.size.some((s) => normalizeMugSize(s) === normalizedMugSize)) {
            size = normalizedMugSize;
            product_type = matchedMug.name;
          }
        }
      }

      // === Handle Acrylic Keychain format ===
      // Example: Type="Acrylic Keychain - 3''" -> product_type="Acrylic Keychain US"
      if (!product_type && typeVariation) {
        const keychainTypeMatch = typeVariation.match(/^(.+?)\s+-\s*(.+)$/);
        if (keychainTypeMatch) {
          const rawKeychainType = keychainTypeMatch[1].trim();
          const rawKeychainSize = keychainTypeMatch[2].trim();
          const mappedType = lookupType(rawKeychainType);
          if (mappedType === keychainProduct.name) {
            const singleInchMatch = rawKeychainSize.match(/^(2|3|4)\s*(?:in|["\u201C\u201D\u2033]|'{1,2})?$/i);
            if (singleInchMatch) {
              size = `${singleInchMatch[1]}''`;
              product_type = keychainProduct.name;
            }
          }
        }
      }

      // === Handle Tough Cases (iPhone) format ===
      // Example: Type="iPhone 15 Pro Max" -> product_type="Tough Cases (iPhone)"
      if (!product_type && typeVariation) {
        const normalizedType = Utils.normalizeVariationValue(typeVariation);
        // Also handle hyphen-before-digit variants: "iPhone-13 / 14" → "iPhone 13 / 14"
        const normalizedTypeNoHyphen = normalizedType.replace(/-(\d)/g, ' $1');
        const matchedIphoneSize = toughCasesIphone.size.find((sz) => {
          const szL = sz.toLowerCase();
          return szL === normalizedType.toLowerCase() || szL === normalizedTypeNoHyphen.toLowerCase();
        });
        if (matchedIphoneSize) {
          size = normalizeToughCasesIphoneSize(matchedIphoneSize);
          product_type = toughCasesIphone.name;
          // iPhone tough cases do not use color as a variant dimension.
          color = '';
        }
      }

      // === Handle pure product type name (no size suffix) ===
      // Example: Type="Premium Embroidery" → product_type="Classic Dad Hat"
      // Example: Type="Classic Dad Hat"    → product_type="Classic Dad Hat" (self-reference)
      if (!product_type && typeVariation) {
        const directLookup = lookupType(typeVariation);
        const lower = typeVariation.toLowerCase();
        const isInTypeMap = Object.keys(typeMap).some(k => k.toLowerCase() === lower);
        if (directLookup && (isInTypeMap || directLookup.toLowerCase() !== lower)) {
          product_type = directLookup;
        }
      }

      // Default size to "One Size" for applicable product types (e.g., hats)
      if (!size && product_type && oneSizeProductTypes.has(product_type)) {
        size = 'One Size';
      }

      // === Handle Flag size format ===
      // Example: Type="Double Printed Flag", Size="36x60 In" → size="Horizontal/36*60"
      // Defaults to Horizontal orientation (most common for outdoor flags).
      if (!size && product_type && /flag/i.test(product_type)) {
        const flagSizeRaw = getVar('Size') || getVar('Sizes');
        if (flagSizeRaw) {
          const flagDimMatch = flagSizeRaw.match(/(\d+)\s*[xX×]\s*(\d+)/);
          if (flagDimMatch) {
            size = `Horizontal/${flagDimMatch[1]}*${flagDimMatch[2]}`;
          }
        }
      }

      // === Handle Window Hanging Suncatcher and similar inch-only ornament products ===
      // OPTION: "Design 1" (ignored for color), SIZE: "6 INCHES" → "6''"
      if (!product_type && /suncatcher/i.test(itemName)) {
        product_type = 'Window Hanging Suncatcher Ornaments 1 layer US';
        if (!size) {
          const suncatcherSizeRaw = getVar('Size');
          const inchOnlyMatch = suncatcherSizeRaw.match(/^(\d+)\s*(?:inches?|in\b|["“”″]|'{1,2})?$/i);
          if (inchOnlyMatch) {
            size = `${inchOnlyMatch[1]}''`;
          }
        }
        color = color || 'Default';
      }

      // === Handle Acrylic Keychain from item title ===
      // Example: title contains "Acrylic Keychain", Size="4in x 4in" -> product_type="Acrylic Keychain US", size="4''"
      if (!product_type && /acrylic keychain/i.test(itemName)) {
        product_type = keychainProduct.name;
        if (!size) {
          const keychainSizeRaw = getVar('Size');
          const keychainSizeMatch = keychainSizeRaw.match(/^(\d+)\s*(?:in)?/i);
          if (keychainSizeMatch) {
            size = `${keychainSizeMatch[1]}''`;
          }
        }
      }

      // === Handle Comfort Colors from item title ===
      // Example: title starts with "Comfort Colors..." → product_type="Comfort colors t-shirt"
      if (!product_type && /^comfort\s+colors?\b/i.test(itemName)) {
        product_type = 'Comfort colors t-shirt';
      }

      // === Handle Baseball Hat from item title ===
      if (!product_type && /\b(?:embroid\w*\s+baseball\s+hat|baseball\s+hat)\b/i.test(itemName)) {
        product_type = 'Baseball Hat';
      }

      // === Handle Classic Dad Hat from item title ===
      if (!product_type && /\b(?:dad\s+hat|racing\s+cap|trucker\s+hat|snapback|fitted\s+cap)\b/i.test(itemName)) {
        product_type = 'Classic Dad Hat';
      }
      if (!product_type && typeVariation && /\bembroid/i.test(typeVariation) && /\b(?:hat|cap)\b/i.test(itemName)) {
        product_type = 'Classic Dad Hat';
      }

      // After title-based detection: apply One Size + color defaults for hat types
      if (product_type === 'Classic Dad Hat' || product_type === 'Baseball Hat' || product_type === 'Trucker Hat') {
        if (!size) size = 'One Size';
        if (!color) {
          const HAT_COLORS = ['Black','White','Navy','Khaki','Beige','Grey','Gray','Red','Blue','Green','Pink','Brown','Tan','Olive','Stone'];
          const titleColorMatch = HAT_COLORS.find(c => new RegExp('\\b' + c + '\\b', 'i').test(itemName));
          color = titleColorMatch || 'Black';
        }
      }

      // === Handle Greeting Card format ===
      // SIZE: "Size 4x6" → size="4x6", product_type="Greetingcard", color="White"
      if (!size) {
        const cardSizeRaw = getVar('Size');
        const cardSizeMatch = cardSizeRaw && cardSizeRaw.match(/^size\s+(\d+)\s*[x×]\s*(\d+)$/i);
        if (cardSizeMatch) {
          size = `${cardSizeMatch[1]}x${cardSizeMatch[2]}`;
          if (!product_type) product_type = 'Greetingcard';
          if (!color) color = 'White';
        }
      }

      // === Handle Greeting Card from item title ===
      if (!product_type && /\b(?:greeting\s*card|birthday\s*card|anniversary\s*card|romance\s*card|holiday\s*card|book\s*lover\s*card)\b/i.test(itemName)) {
        product_type = 'Greetingcard';
        if (!color) color = 'White';
      }

      // === Handle Sticker/Poster format ===
      // Example: Size="3in x 3in" -> size="3''x3''", product_type="Die-cut Stickers US 2"
      // Example: Size="3 x 3" or Size="2x2" -> size="3''x3''"
      const sizeRaw = getVar('Size');
      if (sizeRaw && !size) {
        // Try "Nin x Nin" format (also handles × Unicode multiply sign)
        const inchMatch = sizeRaw.match(/(\d+)\s*(?:in|["\u201C\u201D\u2033]|'{1,2})?\s*[x\u00D7]\s*(\d+)\s*(?:in|["\u201C\u201D\u2033]|'{1,2})?/i);
        if (inchMatch) {
          const w = parseInt(inchMatch[1]);
          const h = parseInt(inchMatch[2]);
          size = `${w}''x${h}''`;
          color = color || 'Default';
          if (!product_type) {
            if (w <= 6 && h <= 6) {
              product_type = 'Die-cut Stickers US 2';
            } else {
              product_type = 'Premium Luster Photo Paper Poster US 2';
            }
          }
        }
      }

      // === Handle Color ===
      // DESIGN key (e.g. "Black-Mucho Picante") is treated as color when value is not a numeric code.
      // Only take the part before the first hyphen: "Black-Mucho Picante" → "Black"
      const designValForColor = getVar('Design');
      let designColorPart = '';
      if (designValForColor && !/^\d+$/.test(designValForColor)) {
        const hyphenIdx = designValForColor.indexOf('-');
        designColorPart = hyphenIdx > 0 ? designValForColor.substring(0, hyphenIdx).trim() : designValForColor;
      }
      const colorRaw = getVar('Shirt Colors') || getVar('Colors') || getVar('Color') || designColorPart;
      let design = '';
      if (colorRaw && color !== 'Default') {
        const styleMap = {
          'ComfortShirt': 'Comfort colors t-shirt',
          'Comfort Shirt': 'Comfort colors t-shirt',
          'ComfortColors': 'Comfort colors t-shirt',
          'Comfort': 'Comfort colors t-shirt',
          'Gildan': 'Gildan T-shirt',
          'Hoodie': 'Hoodie', 'Sweatshirt': 'Sweatshirt', 'Sweashirt': 'Sweatshirt'
        };
        // Case-insensitive lookup: colorStyleMap (API) first, then hardcoded styleMap
        const lookupStyle = (code) => {
          if (!code) return '';
          const lower = code.toLowerCase();
          for (const [k, v] of Object.entries(colorStyleMap)) {
            if (k.toLowerCase() === lower) return v;
          }
          for (const [k, v] of Object.entries(styleMap)) {
            if (k.toLowerCase() === lower) return v;
          }
          return '';
        };

        // Parentheses format: "Berry (Comfortshirt)" or "Pepper(ComfortShirt)"
        const parenMatch = colorRaw.match(/^(.+?)\s*\((.+?)\)$/);
        // Hyphen format: "Black - Comfort" or "Black - Gildan"
        const hyphenStyleMatch = !parenMatch && colorRaw.match(/^(.+?)\s+-\s+(Comfort(?:shirt|\s*colors?)?|Gildan|Hoodie|Sweatshirt|Sweashirt)\s*$/i);

        if (parenMatch) {
          color = parenMatch[1].trim();
          const styleCode = parenMatch[2].trim();
          const mappedType = lookupStyle(styleCode);
          // styleCode in parentheses is more specific — always override product_type if mapped
          if (mappedType) {
            product_type = mappedType;
          } else if (!product_type) {
            product_type = styleCode;
          }
        } else if (hyphenStyleMatch) {
          color = hyphenStyleMatch[1].trim();
          const styleCode = hyphenStyleMatch[2].trim();
          const mappedType = lookupStyle(styleCode);
          if (mappedType) {
            product_type = mappedType;
          } else if (!product_type) {
            product_type = styleCode;
          }
        } else {
          color = colorRaw;
        }
      }

      // Acrylic Keychain US always uses Default color.
      if (product_type === keychainProduct.name) {
        color = keychainProduct.color[0];
      }
      // Acrylic Keychain 2 side US always uses Default color.
      if (product_type === keychain2SideProduct.name) {
        color = keychain2SideProduct.color[0];
      }
      // Greetingcard always uses White color.
      if (product_type === 'Greetingcard') {
        color = 'White';
      }

      // === 3D-VN product types: override color based on product_type ===
      // For 3D-VN products, the Etsy "Color" (e.g. "Red - Style 2") is actually
      // a style/design variant, not a real color. The real color is fixed per product_type.
      const productTypeColorMap = {
        '3D-VN  Mesh football jersey': '3D Printed',
        '3D-VN PREMIUM BASEBALL JERSEY (BORDERS)': '3D Printed',
        '3D-VN Kid Youth Baseball Jersey Border': '3D Printed',
        '3D-VN All-Over Print Mesh Football Crop Top Jersey': '3D Print Cothing',
        '3D-VN All Over Print Player Football Jersey': '3D Print Cothing',
        '3D-VN MF All-over Print Lace Neck Hockey Jersey': '3D Print Cothing',
        '3D-VN MF All-over Print Hockey Jersey': '3D Print Cothing',
        '3D-VN AOP V-Neck Hockey Jersey': '3D Print Cothing',
        '3D-VN All Over Print Men Polo Premium Shirt': '3D Printed',
        '3D-VN All Over Print Women Polo Premium Shirt': '3D Printed',
        '3D-VN US HAWAIIAN SHIRT': '3D Printed',
        '3D-VN USA Polyester and Double Printed Flag': '3D Printed',
      };
      if (product_type && productTypeColorMap[product_type]) {
        // Extract style number from color (e.g. "Red - Style 2" → design "2")
        if (color && !design) {
          const styleNum = color.match(/Style\s*(\d+)/i);
          if (styleNum) {
            design = styleNum[1];
          }
        }
        color = productTypeColorMap[product_type];
      }

      // === Handle Design variation ===
      const designRaw = getVar('Design');
      if (designRaw) {
        const designNum = designRaw.match(/(\d+)/);
        if (designNum) {
          design = designNum[1];
        }
      }

      // Also check OPTION key for "Design N" pattern (e.g. OPTION: "Design 1")
      if (!design) {
        const optionVal = getVar('Option');
        if (optionVal) {
          const optionDesignNum = optionVal.match(/Design\s*(\d+)/i);
          if (optionDesignNum) {
            design = optionDesignNum[1];
          }
        }
      }

      // Also check TYPE key for "DESIGN N" pattern (e.g. TYPE: "DESIGN 2" for Acrylic Keychain 2 side)
      if (!design) {
        const typeValForDesign = getVar('Type');
        if (typeValForDesign) {
          const typeDesignMatch = typeValForDesign.match(/^design\s*(\d+)$/i);
          if (typeDesignMatch) design = typeDesignMatch[1];
        }
      }

      // === Tough Cases (iPhone) always default to White ===
      if (product_type === toughCasesIphone.name) {
        color = 'White';
      }

      // === Handle SKU field as product_type fallback ===
      // e.g. "P.T-Shirt" → strip prefix like "P." → "T-Shirt" → lookupType
      if (!product_type) {
        const skuField = getVar('SKU');
        if (skuField) {
          const skuTypePart = skuField.replace(/^[A-Za-z]+\.\s*/i, '').trim();
          if (skuTypePart) {
            product_type = lookupType(skuTypePart);
          }
        }
      }

      // === Determine brightness ===
      if (color && darkColors.some(dc => color.toLowerCase().includes(dc))) {
        brightness = 'dark';
      }

      return { size, color, product_type, brightness, design };
    }

    /**
     * Scrape order detail from peek overlay (right panel)
     */
    async scrapeOrderDetail() {

      const peekPanel = document.querySelector('[class*="peek-overlay"]') ||
                       document.querySelector('.wt-overflow-y-scroll') ||
                       document.querySelector('[data-clg-id="wtTabPanel"]');

      if (!peekPanel) {
        return null;
      }

      // Get shop name from URL
      let shopName = 'Etsy Store';
      const urlMatch = window.location.href.match(/\/your\/shops\/([^\/]+)/);
      if (urlMatch) {
        shopName = decodeURIComponent(urlMatch[1]);
      }

      const order = {
        platform: 'Etsy',
        shop_name: shopName,
        order_id: null,
        customer_name: '',
        email: '',
        address_1: '',
        address_2: '',
        city: '',
        state: '',
        country: 'United States',
        zipcode: '',
        phone_number: '',
        note: '',
        revenue: null,
        shipping_cost: null,
        status: 'PENDING',
        items: [],
        date_created: null
      };

      // Get order ID from Receipt #
      const receiptMatch = peekPanel.textContent.match(/Receipt\s*#(\d+)/);
      if (receiptMatch) {
        order.order_id = `ETSY-${receiptMatch[1]}`;
      }

      // === ORDER DATE ===
      const orderDescEl = peekPanel.querySelector('[data-testid="order-description"]');
      const orderedText = orderDescEl ? orderDescEl.textContent : peekPanel.textContent;
      const dateNewMatch = orderedText.match(/Ordered\s+(\d{1,2}:\d{2}(?:am|pm)),\s*\w+,\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
      if (dateNewMatch) {
        order.date_created = Utils.parseEtsyOrderedDate(dateNewMatch[1], dateNewMatch[2]);
      } else {
        const dateOldMatch = orderedText.match(/Ordered\s+([A-Za-z]{3}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/);
        if (dateOldMatch) order.date_created = Utils.formatDate(dateOldMatch[1]);
      }

      // === CUSTOMER NAME ===
      // From: span.name or Mary Struve in address section
      const nameEl = peekPanel.querySelector('span.name, .address span[class="name"]');
      if (nameEl) {
        order.customer_name = Utils.safeText(nameEl);
      }

      // Fallback from header
      if (!order.customer_name) {
        const headerName = peekPanel.querySelector('.wt-text-title-01, h2, h3');
        if (headerName) {
          const nameMatch = Utils.safeText(headerName).match(/Order from\s+(.+)/i);
          if (nameMatch) {
            order.customer_name = nameMatch[1].trim();
          }
        }
      }

      // === SHIPPING ADDRESS ===
      // From: Ship to section with class="address break-word fs-mask"
      const addressDiv = peekPanel.querySelector('.address.break-word.fs-mask, div[class*="address"]');
      if (addressDiv) {
        // Customer name
        const shipNameEl = addressDiv.querySelector('span.name');
        if (shipNameEl && !order.customer_name) {
          order.customer_name = Utils.safeText(shipNameEl);
        }

        // Address line 1 (first-line)
        const firstLineEl = addressDiv.querySelector('span.first-line');
        if (firstLineEl) {
          order.address_1 = Utils.safeText(firstLineEl);
        }

        // City
        const cityEl = addressDiv.querySelector('span.city');
        if (cityEl) {
          order.city = Utils.safeText(cityEl);
        }

        // State
        const stateEl = addressDiv.querySelector('span.state');
        if (stateEl) {
          order.state = Utils.safeText(stateEl);
        }

        // Zipcode
        const zipEl = addressDiv.querySelector('span.zip');
        if (zipEl) {
          order.zipcode = Utils.safeText(zipEl);
        }

        // Country
        const countryEl = addressDiv.querySelector('span.country-name');
        if (countryEl) {
          order.country = Utils.safeText(countryEl);
        }
      }

      // === TOTALS ===
      // Earned amount (Earnings tab: "You earned $32.37 on this order")
      const earnedEl = peekPanel.querySelector('.wt-text-title-large.wt-display-inline');
      if (earnedEl) {
        const { amount } = Utils.parsePrice(Utils.safeText(earnedEl));
        if (amount !== null) order.revenue = amount;
      }
      if (!order.revenue) {
        const earnedMatch = peekPanel.textContent.match(/You earned\s*\$?([\d,.]+)/i);
        if (earnedMatch) order.revenue = parseFloat(earnedMatch[1].replace(',', ''));
      }
      // Fallback: Order total
      if (!order.revenue) {
        const orderTotalMatch = peekPanel.textContent.match(/Order total\s*\$?([\d,.]+)/i);
        if (orderTotalMatch) order.revenue = parseFloat(orderTotalMatch[1].replace(',', ''));
      }

      // Shipping cost
      const shippingMatch = peekPanel.textContent.match(/Shipping\s*(?:price)?\s*\$?([\d,.]+)/i);
      if (shippingMatch) {
        order.shipping_cost = parseFloat(shippingMatch[1].replace(',', ''));
      }

      // === ITEMS with PRICES ===
      // From the receipt table with 3 Item(s) header
      const itemTable = peekPanel.querySelector('table');
      if (itemTable) {
        const rows = itemTable.querySelectorAll('tbody tr');
        rows.forEach((row, index) => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 3) {
            // Cell 0: Item info (name, transaction ID, variations)
            // Cell 1: Quantity
            // Cell 2: Item price

            const item = {
              sku: '',
              sku_name: '',
              name: '',
              quantity: 1,
              price: null,
              image_url: '',
              product_url: '',
              variations: {},
              personalization: ''
            };

            const itemCell = cells[0];
            const qtyCell = cells[1];
            const priceCell = cells[2];

            // Get product name from link
            const productLink = itemCell.querySelector('a[href*="/transaction/"]');
            if (productLink) {
              item.product_url = productLink.href;
              item.name = Utils.safeText(productLink);

              const skuMatch = productLink.href.match(/\/transaction\/(\d+)/);
              if (skuMatch) {
                item.sku = skuMatch[1];
              }
            }

            // Get image
            const imgEl = itemCell.querySelector('img');
            if (imgEl) {
              // Convert thumbnail to larger size
              let imgUrl = imgEl.src;
              if (imgUrl.includes('il_75x75')) {
                imgUrl = imgUrl.replace('il_75x75', 'il_300x300');
              } else if (imgUrl.includes('il_170x135')) {
                imgUrl = imgUrl.replace('il_170x135', 'il_300x300');
              }
              item.image_url = imgUrl;
            }

            // Get quantity
            item.quantity = parseInt(Utils.safeText(qtyCell)) || 1;

            // Get item price (e.g., "$28.99")
            const priceText = Utils.safeText(priceCell);
            const priceMatch = priceText.match(/\$?([\d,.]+)/);
            if (priceMatch) {
              item.price = parseFloat(priceMatch[1].replace(',', ''));
            }

            // Get variations from item cell — try DOM parsing first (handles "Type  Value" without colon)
            const variationLis = itemCell.querySelectorAll('li.clearfix, ul.list-unstyled > li');
            variationLis.forEach(li => {
              const labelEl = li.querySelector('.text-gray-lighter');
              const valueEl = li.querySelector('.strong');
              if (labelEl && valueEl) {
                const label = Utils.safeText(labelEl);
                const value = Utils.normalizeVariationValue(Utils.safeText(valueEl));
                if (label && value && label !== 'Quantity') {
                  item.variations[label] = value;
                }
              } else {
                const liText = Utils.safeText(li);
                if (liText && liText.includes(':')) {
                  const [label, ...valueParts] = liText.split(':');
                  const labelClean = label.trim();
                  const valueClean = valueParts.join(':').trim();
                  if (labelClean && valueClean && labelClean !== 'Quantity') {
                    item.variations[labelClean] = Utils.normalizeVariationValue(valueClean);
                  }
                }
              }
            });

            // Regex fallback for any variation not yet captured via DOM
            const itemText = itemCell.textContent;
            const variationPatterns = [
              { key: 'Shirt size', pattern: /Shirt size[:\s]*([^\n]+)/i },
              { key: 'Shirt Colors', pattern: /Shirt Colors?[:\s]*([^\n]+)/i },
              { key: 'Type', pattern: /\bType\s*[:\s]\s*([^\n]+)/i },
              { key: 'Style', pattern: /(?:^|\n)\s*Style[:\s]+([^\n]+)/i },
              { key: 'Style and Size', pattern: /Style and Size[:\s]*([^\n]+)/i },
              { key: 'Sizes', pattern: /(?:^|\n)\s*Sizes[:\s]+([^\n]+)/i },
              { key: 'Size', pattern: /(?:^|\n)\s*Size[:\s]+([^\n]+)/i },
              { key: 'Color', pattern: /(?:^|\n)\s*Colors?[:\s]+([^\n]+)/i },
              { key: 'Design', pattern: /(?:^|\n)\s*Design[:\s]+([^\n]+)/i },
              { key: 'Option', pattern: /(?:^|\n)\s*Option[:\s]+([^\n]+)/i },
              { key: 'Personalization', pattern: /(?:^|\n)\s*Personalization[:\s]+([^\n]+)/i },
              { key: 'SKU', pattern: /(?:^|\n)\s*SKU[:\s]+([^\n]+)/i },
            ];

            for (const { key, pattern } of variationPatterns) {
              if (item.variations[key]) continue; // already captured via DOM
              const match = itemText.match(pattern);
              if (match) {
                item.variations[key] = Utils.normalizeText(match[1].trim());
              }
            }

            // Fallback: catch "Label Size" lines like "Unisex Ringer T-Shirt XL"
            // where the variation group name is the label and the size is the value
            if (!item.variations['Size'] && !item.variations['Shirt size'] && !item.variations['Style and Size'] && !item.variations['Type']) {
              const sizeSuffixMatch = itemText.match(/^([\w][\w\s\-\/]+?)\s+(5XL|4XL|3XL|XXXL|2XL|XXL|XL|L|M|S|XS)\s*$/im);
              if (sizeSuffixMatch) {
                const rawLabel = sizeSuffixMatch[1].trim();
                const skipLabels = /^(Shirt size|Unisex shirt size|Sizes?|Style|Type|Color|Colors|Design|Option|SKU|Personalization)/i;
                if (!skipLabels.test(rawLabel) && !item.variations[rawLabel]) {
                  item.variations[rawLabel] = sizeSuffixMatch[2].toUpperCase();
                }
              }
            }

            // Extract personalization from variations
            // 1. Match by key name "Personalization"
            let notRequestedPersonalization = false;
            const personalizationKey = Object.keys(item.variations).find(k => /^personalization$/i.test(k));
            if (personalizationKey) {
              const pVal = item.variations[personalizationKey];
              if (pVal && !/not requested/i.test(pVal)) {
                item.personalization = pVal;
              } else if (pVal && /not requested/i.test(pVal)) {
                notRequestedPersonalization = true;
              }
              delete item.variations[personalizationKey];
            }
            // 2. Also remove any variation whose VALUE contains personalization boilerplate
            for (const [key, value] of Object.entries(item.variations)) {
              if (/personalization/i.test(value)) {
                if (!/not requested/i.test(value)) {
                  item.personalization = item.personalization || value.replace(/^personalization[:\s]*/i, '').trim();
                } else {
                  notRequestedPersonalization = true;
                }
                delete item.variations[key];
              }
            }

            // Build sku_name from all scraped variations
            const skuParts = [];
            const priorityKeys = [
              'Style and Size', 'Type', 'Sizes', 'Size', 'Shirt size',
              'Color', 'Colors', 'Shirt Colors',
              'Style', 'Design', 'Option'
            ];
            for (const key of priorityKeys) {
              if (item.variations[key]) skuParts.push(item.variations[key]);
            }
            if (skuParts.length === 0) {
              for (const [, value] of Object.entries(item.variations)) {
                skuParts.push(value);
              }
            }
            // Also include values from unknown variation keys not already in skuParts
            const detailPriorityKeySet = new Set(priorityKeys);
            for (const [key, value] of Object.entries(item.variations)) {
              if (!detailPriorityKeySet.has(key) && !skuParts.includes(value)) {
                skuParts.unshift(value);
              }
            }
            item.sku_name = skuParts.join(', ');

            // Append personalization to sku_name if present
            if (item.personalization) {
              item.sku_name += `, Personalization: ${item.personalization}`;
            }

            // Append "Not requested this on item" to sku when personalization was not requested
            if (notRequestedPersonalization) {
              item.sku += (item.sku ? ', ' : '') + 'Not requested this on item';
            }

            // Normalize item name
            item.name = Utils.normalizeText(item.name);

            // Parse variants (size, color, product_type, brightness)
            item.parsed_variants = this.parseVariants(item.variations, item.name);

            if (item.sku || item.name) {
              order.items.push(item);
            }
          }
        });
      }

      return order;
    }

    /**
     * Map Etsy status to standard status
     */
    mapStatus(statusText) {
      const statusMap = {
        'PAID': 'PENDING',
        'COMPLETED': 'COMPLETED',
        'SHIPPED': 'IN_TRANSIT',
        'DELIVERED': 'DELIVERED',
        'CANCELLED': 'CANCELLED',
        'REFUNDED': 'SUPPLIER_REFUND',
        'OPEN': 'PENDING',
        'NOT SHIPPED': 'AWAITING_SHIPMENT',
        'PRE-TRANSIT': 'AWAITING_SHIPMENT',
        'IN TRANSIT': 'IN_TRANSIT',
        'PROCESSING': 'PROCESSING'
      };

      const upper = (statusText || '').toUpperCase();
      for (const [key, value] of Object.entries(statusMap)) {
        if (upper.includes(key)) {
          return value;
        }
      }
      return 'PENDING';
    }

    /**
     * Main scrape method - auto-detects page type
     */
    async scrape() {
      // Load dynamic type mappings from API before scraping
      await this.loadTypeMappings();

      const orderRows = document.querySelectorAll('.panel-body-row');

      if (orderRows.length > 0) {
        return await this.scrapeOrderList();
      }

      const peekPanel = document.querySelector('[class*="peek-overlay"]');
      if (peekPanel) {
        const order = await this.scrapeOrderDetail();
        return order ? [order] : [];
      }

      return [];
    }

    /**
     * Get visible order count
     */
    getOrderCount() {
      return document.querySelectorAll('.panel-body-row').length;
    }
  }

  // Expose scraper to global scope
  window.VHEtsyOrderScraper = EtsyOrderScraper;
})();
