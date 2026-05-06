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
    parseEtsyOrderedDate: (timeStr, dateStr) => {
      try {
        const timeParts = timeStr.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
        if (!timeParts) return Utils.formatDate(dateStr);
        let h = parseInt(timeParts[1]);
        const m = parseInt(timeParts[2]);
        const ampm = timeParts[3].toLowerCase();
        if (ampm === 'pm' && h !== 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
        const d = new Date(`${dateStr} 00:00:00`);
        if (isNaN(d)) return null;
        d.setHours(h, m, 0, 0);
        return isNaN(d) ? null : d.toISOString();
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
      this._typeMap = null;        // cached type mappings from API
      this._colorStyleMap = null;  // cached color-style mappings from API
    }

    /**
     * Load variant type mappings from backend API.
     * Cached for the lifetime of this scraper instance.
     * Falls back to hardcoded defaults if API is unavailable.
     */
    async loadTypeMappings() {
      if (this._typeMap && this._colorStyleMap) return; // already loaded

      const DEFAULT_TYPE_MAP = {
        'T-Shirt': 'T-shirt', 'Hoodie': 'Hoodie', 'Sweatshirt': 'Sweatshirt',
        'Comfort TShirt': 'Comfort colors t-shirt',
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
        'Suncatcher': 'Window Hanging Suncatcher Ornaments 1 layer US',
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

        const resp = await chrome.runtime.sendMessage({
          type: 'ETSY_FETCH',
          payload: {
            url: `${apiUrl}/api/ecommerce/variant-type-mappings/`,
            options: {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              }
            }
          }
        });

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

          // Get earned revenue from Earnings tab panel
          const earnedEl = panel.querySelector('.wt-text-title-large.wt-display-inline');
          if (earnedEl) {
            const { amount } = Utils.parsePrice(Utils.safeText(earnedEl));
            if (amount !== null) order.revenue = amount;
          }
          if (!order.revenue) {
            const earnedMatch = panel.textContent.match(/You earned\s*\$?([\d,.]+)/i);
            if (earnedMatch) order.revenue = parseFloat(earnedMatch[1].replace(',', ''));
          }

          // Try to find address with multiple selectors
          const addressSelectors = [
            '.address.break-word.fs-mask',
            'div.address.fs-mask',
            '[class*="address"][class*="fs-mask"]',
            '.shipping-address',
            '[data-region="shipping-address"]',
            '.wt-break-word'
          ];

          let addressDiv = null;
          for (const selector of addressSelectors) {
            addressDiv = panel.querySelector(selector);
            if (addressDiv) break;
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
          }

          // Get item prices from table
          const itemTable = panel.querySelector('table');
          if (itemTable && order.items.length > 0) {
            const rows = itemTable.querySelectorAll('tbody tr');
            let itemIndex = 0;
            rows.forEach((tr) => {
              if (tr.querySelector('th')) return;

              const priceCell = tr.querySelector('td.text-right, td[class*="text-right"]');
              if (priceCell && order.items[itemIndex]) {
                const pTag = priceCell.querySelector('p');
                const priceText = pTag ? Utils.safeText(pTag) : Utils.safeText(priceCell);
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
      const addressDiv = row.querySelector('.address.break-word.fs-mask, div.address.fs-mask, .fs-mask');
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
      if (!order.city) {
        const shipToMatch = row.textContent.match(/Ship to\s+([^,]+),\s*(\w{2})/i);
        if (shipToMatch) {
          order.city = shipToMatch[1].trim();
          order.state = shipToMatch[2].trim();
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
            // Method 3: Just get text content if li has text
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

      // Use dynamic mappings loaded from API (with hardcoded fallback)
      const typeMap = this._typeMap || {
        'T-Shirt': 'T-Shirt', 'TShirt': 'T-Shirt', 'Hoodie': 'Hoodie', 'Sweatshirt': 'Sweatshirt',
        'Comfort TShirt': 'Comfort colors t-shirt',
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
        'Suncatcher': 'Window Hanging Suncatcher Ornaments 1 layer US',
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
        return rawType;
      };

      // === Handle "Style and Size" format ===
      // Example: "Unisex T-shirt XL" -> size="XL", product_type="T-shirt"
      const styleAndSize = variations['Style and Size'] || '';
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
      const styleVariation = variations['Style'] || '';
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

      // === Handle "Shirt size" / "Unisex shirt size" format ===
      // Example: "Hoodie - 2XL" -> size="2XL", product_type="Hoodie"
      const shirtSize = variations['Shirt size'] || variations['Unisex shirt size'] || variations['Sizes'] || variations['Size'] || '';
      if (!size && shirtSize && shirtSize.includes(' - ')) {
        const parts = shirtSize.split(' - ');
        if (parts.length >= 2) {
          const rawType = parts[0].trim();
          size = parts[1].trim();
          if (!product_type) {
            product_type = lookupType(rawType);
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

      // === Handle "Type-Size" format ===
      // Example: "Hoodie-2XL" -> size="2XL", product_type="Hoodie"
      const typeSize = variations['Type-Size'] || variations['Type - Size'] || '';
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

      // === Handle "Type" format ===
      // Example: "Wash T-shirt - 2XL" -> size="2XL", product_type="Mineral Wash Colortone 1300"
      // Example: "Die Sticker - 2"x2"" -> size="2''x2''", product_type="Die-cut Stickers US 2"
      // Example: "Die Sticker -2"x2"" -> size="2''x2''", product_type="Die-cut Stickers US 2"
      // Example: "Poster - 8x12" -> size="8''x12''", product_type="Premium Luster Photo Paper Poster US 2"
      const typeVariation = variations['Type'] || '';
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
        const matchedIphoneSize = toughCasesIphone.size.find((sz) => sz.toLowerCase() === normalizedType.toLowerCase());
        if (matchedIphoneSize) {
          size = normalizeToughCasesIphoneSize(matchedIphoneSize);
          product_type = toughCasesIphone.name;
          // iPhone tough cases do not use color as a variant dimension.
          color = '';
        }
      }

      // === Handle Window Hanging Suncatcher and similar inch-only ornament products ===
      // OPTION: "Design 1" (ignored for color), SIZE: "6 INCHES" → "6''"
      if (!product_type && /suncatcher/i.test(itemName)) {
        product_type = 'Window Hanging Suncatcher Ornaments 1 layer US';
        if (!size) {
          const suncatcherSizeRaw = variations['Size'] || variations['SIZE'] || '';
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
          const keychainSizeRaw = variations['Size'] || '';
          const keychainSizeMatch = keychainSizeRaw.match(/^(\d+)\s*(?:in)?/i);
          if (keychainSizeMatch) {
            size = `${keychainSizeMatch[1]}''`;
          }
        }
      }

      // === Handle Sticker/Poster format ===
      // Example: Size="3in x 3in" -> size="3''x3''", product_type="Die-cut Stickers US 2"
      // Example: Size="3 x 3" or Size="2x2" -> size="3''x3''"
      const sizeRaw = variations['Size'] || '';
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
      const colorRaw = variations['Shirt Colors'] || variations['Colors'] || variations['Color'] || '';
      let design = '';
      if (colorRaw && color !== 'Default') {
        // Check for parentheses format: "Pepper(ComfortShirt)"
        const parenMatch = colorRaw.match(/^(.+?)\((.+?)\)$/);
        if (parenMatch) {
          color = parenMatch[1].trim();
          const styleCode = parenMatch[2].trim();
          const styleMap = {
            'ComfortShirt': 'Comfort colors t-shirt',
            'Comfort Shirt': 'Comfort colors t-shirt',
            'ComfortColors': 'Comfort colors t-shirt',
            'Gildan': 'Gildan T-shirt',
            'Hoodie': 'Hoodie', 'Sweatshirt': 'Sweatshirt', 'Sweashirt': 'Sweatshirt'
          };
          // styleCode in parentheses is more specific — always override product_type if mapped
          const mappedType = colorStyleMap[styleCode] || styleMap[styleCode];
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
      const designRaw = variations['Design'] || variations['design'] || '';
      if (designRaw) {
        const designNum = designRaw.match(/(\d+)/);
        if (designNum) {
          design = designNum[1];
        }
      }

      // === Tough Cases (iPhone) always default to White ===
      if (product_type === toughCasesIphone.name) {
        color = 'White';
      }

      // === Handle SKU field as product_type fallback ===
      // e.g. "P.T-Shirt" → strip prefix like "P." → "T-Shirt" → lookupType
      if (!product_type) {
        const skuField = variations['SKU'] || '';
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

            // Get variations from item cell - handle all variation types
            const itemText = itemCell.textContent;
            const variationPatterns = [
              { key: 'Shirt size', pattern: /Shirt size[:\s]*([^\n]+)/i },
              { key: 'Shirt Colors', pattern: /Shirt Colors?[:\s]*([^\n]+)/i },
              { key: 'Type', pattern: /(?:^|\n)\s*Type[:\s]+([^\n]+)/i },
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
              const match = itemText.match(pattern);
              if (match) {
                item.variations[key] = Utils.normalizeText(match[1].trim());
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
