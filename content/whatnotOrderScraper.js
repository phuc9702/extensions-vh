/**
 * VH Whatnot Order Scraper (ISOLATED world)
 * Listens for CustomEvents from whatnotFetchInterceptor.js (MAIN world).
 * Exports window.VHWhatnotScraper for the sync button.
 */
(function () {
  'use strict';

  if (window.__VH_WHATNOT_SCRAPER__) return;
  window.__VH_WHATNOT_SCRAPER__ = true;

  const _orders = new Map();
  const _listingToOrder = new Map(); // listing GQL id → order_id, for variant enrichment
  let _sellerUsername = '';
  let _lastOrderId = null; // tracks most recently processed single-order (for receipt linking)

  // ── Money helper ──
  function parseMoney(obj) {
    if (!obj) return 0;
    const v = obj.amount != null ? obj.amount : (obj.amountSafe || 0);
    return Math.round(v) / 100;
  }

  // ── Status map ──
  const STATUS_MAP = {
    completed: 'COMPLETED', complete: 'COMPLETED', sold: 'COMPLETED',
    shipped: 'SHIPPED', shipping: 'SHIPPED', intransit: 'SHIPPED',
    cancelled: 'CANCELLED', canceled: 'CANCELLED',
    refunded: 'REFUNDED', refundcomplete: 'REFUNDED',
    pending: 'PENDING', pendingreview: 'PENDING',
    contactingseller: 'PENDING', preparingpackage: 'PROCESSING'
  };

  function mapStatus(raw) {
    if (!raw) return 'PENDING';
    const key = raw.toLowerCase().replace(/[^a-z]/g, '');
    return STATUS_MAP[key] || raw.toUpperCase();
  }

  function parseDate(raw) {
    if (!raw) return '';
    try { return new Date(raw).toISOString().slice(0, 19); } catch (e) { return raw; }
  }

  // ── Decode Whatnot base64 GraphQL Node ID → numeric string ──
  // e.g. "T3JkZXJOb2RlOjk5NTM2MDgzMQ==" → atob → "OrderNode:995360831" → "995360831"
  function decodeWhatnotId(b64) {
    if (!b64 || typeof b64 !== 'string') return null;
    try {
      const decoded = atob(b64);
      const m = decoded.match(/:(\d+)$/);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  // ── Variant parsing ──
  const SIZE_LIST = ['xs','s','m','l','xl','2xl','3xl','4xl','5xl','xxl','xxxl','xxxxl',
                     '6','7','8','9','10','11','12','13','14','os','onesize','one size'];

  const LIGHT_COLORS = ['white','cream','ivory','yellow','natural','sand','tan','beige',
                        'light','nude','pink','peach','mint','lavender','lilac','silver'];

  function isLightColor(c) {
    return LIGHT_COLORS.some(lc => c.toLowerCase().includes(lc));
  }

  /**
   * Business rule:
   *   - title có "comfort color" → product_type = "Comfort Colors"
   *   - title có "hoodie"        → product_type = "Hoodie"
   *   - còn lại                  → product_type = "T-Shirt" (áo thường)
   */
  function detectProductType(title) {
    if (!title) return 'T-Shirt';
    const t = title.toLowerCase();
    if (t.includes('comfort color') || t.includes('comfort colour')) return 'Comfort Colors';
    if (t.includes('hoodie') || t.includes('hoody'))                  return 'Hoodie';
    if (t.includes('sweatshirt') || t.includes('crewneck'))           return 'Sweatshirt';
    if (t.includes('long sleeve') || t.includes('longsleeve'))        return 'Long Sleeve';
    if (t.includes('tank top') || t.includes('tank tee'))             return 'Tank Top';
    return 'T-Shirt';
  }

  /**
   * Main variant parser.
   * selectedOptions: [{name:"Size", value:"XL"}, {name:"Color", value:"Black"}]
   * productTitle:    used to detect product_type (Comfort Colors vs T-Shirt, etc.)
   * variantTitle:    fallback string "XL / Black" when selectedOptions is empty
   */
  function parseVariants(selectedOptions, variantTitle, productTitle) {
    const r = {
      size: '',
      color: '',
      product_type: detectProductType(productTitle),  // từ title
      brightness: '',
      design: ''
    };

    if (selectedOptions && selectedOptions.length > 0) {
      // Ưu tiên selectedOptions có cấu trúc rõ ràng
      selectedOptions.forEach(opt => {
        const n = (opt.name || '').toLowerCase();
        const v = (opt.value || '').trim();

        if (n === 'variant' || n.includes('variant')) {
          // Whatnot "Variant" field = the specific SIZE ordered (e.g. "L", "XL")
          // May also be compound: "XL / Black" from title bracket
          const parts = v.split(/\s*[\/\-]\s*/).map(p => p.trim()).filter(Boolean);
          if (parts.length > 1) {
            // Compound: parse each part individually
            parts.forEach(p => {
              const pk = p.toLowerCase().replace(/\s/g, '');
              if (SIZE_LIST.includes(pk)) {
                if (!r.size) r.size = p.toUpperCase();
              } else if (!r.color) {
                r.color = p;
                r.brightness = isLightColor(p) ? 'light' : 'dark';
              }
            });
          } else {
            const key = v.toLowerCase().replace(/\s/g, '');
            if (SIZE_LIST.includes(key)) {
              r.size = v.toUpperCase();
            } else if (!r.color) {
              r.color = v;
              r.brightness = isLightColor(v) ? 'light' : 'dark';
            }
          }
        } else if (n.includes('size') || n === 'sz') {
          // Whatnot "Size" field may be "Black S to XL" (color + range) or just a size
          const key = v.toLowerCase().replace(/\s/g, '');
          if (SIZE_LIST.includes(key)) {
            if (!r.size) r.size = v.toUpperCase();
          } else {
            // Extract color = words before the first SIZE_LIST token (e.g. "Black" from "Black S to XL")
            const parts = v.split(/\s+/);
            const colorParts = [];
            for (const p of parts) {
              const pk = p.toLowerCase();
              if (SIZE_LIST.includes(pk) || /^to$/i.test(p)) break;
              colorParts.push(p);
            }
            if (colorParts.length > 0) {
              r.color = colorParts.join(' ');
              r.brightness = isLightColor(r.color) ? 'light' : 'dark';
            } else if (!r.size) {
              r.size = v;
            }
          }
        } else if (n.includes('color') || n.includes('colour')) {
          r.color = v;
          r.brightness = isLightColor(v) ? 'light' : 'dark';
        } else if (n.includes('design') || n.includes('graphic')) {
          r.design = v;
        }
        // Không override product_type từ option — đã detect từ title
      });
    } else if (variantTitle) {
      // Fallback: parse từ chuỗi "XL / Black" hoặc "L - White"
      const parts = variantTitle.split(/[\/\-,|]/).map(p => p.trim()).filter(Boolean);
      parts.forEach(part => {
        const key = part.toLowerCase().replace(/\s/g, '');
        if (SIZE_LIST.includes(key)) {
          r.size = part.toUpperCase();
        } else if (!r.color) {
          r.color = part;
          r.brightness = isLightColor(part) ? 'light' : 'dark';
        }
      });
    }

    return r;
  }

  function buildSkuName(productTitle, variantTitle) {
    if (!variantTitle) return productTitle || '';
    return `${productTitle || ''} - ${variantTitle}`.trim().replace(/^-\s*/, '');
  }

  // Extract variant string from trailing brackets in title
  // "...Safety Education [L]" → "L"
  // "...Concert Tee [XL / Black]" → "XL / Black"
  function extractTitleVariant(title) {
    if (!title) return '';
    const m = title.match(/\[([^\]]+)\]\s*$/);
    return m ? m[1].trim() : '';
  }

  // Strip trailing [variant] from title for clean display
  function stripTitleVariant(title) {
    if (!title) return '';
    return title.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
  }

  // Parse trailing ", Color, Size" from Whatnot listing titles.
  // e.g. "90s Ramones T-shirt, Black, L" → { size:'L', color:'Black', cleanTitle:'90s Ramones T-shirt' }
  // Returns null if the pattern is not found.
  function parseCSVTitle(title) {
    if (!title) return null;
    const parts = title.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const sizePart  = parts[parts.length - 1];
    const colorPart = parts[parts.length - 2];
    const sizeKey   = sizePart.toLowerCase().replace(/\s/g, '');
    if (!SIZE_LIST.includes(sizeKey)) return null;
    // Guard: colorPart must not itself be a size (e.g. "S, M, L")
    if (SIZE_LIST.includes(colorPart.toLowerCase().replace(/\s/g, ''))) return null;
    return {
      size:       sizePart.toUpperCase(),
      color:      colorPart,
      brightness: isLightColor(colorPart) ? 'light' : 'dark',
      cleanTitle: parts.slice(0, parts.length - 2).join(', ')
    };
  }

  // ── Item builder ──
  function buildItems(raw) {
    const orderUrl = `https://www.whatnot.com/dashboard/orders/${raw.id}`;

    // ── Pattern 1: order has a single listing object ──
    const listing = raw.listing || raw.product || raw.item || raw.orderItem;
    // Accept listing even without id (Whatnot sometimes omits id in list queries)
    if (listing && (listing.id || listing.title || listing.name)) {
      const productTitle = listing.title || listing.name || '';
      const listingId = listing.id || listing.listingId || listing.lid || raw.id;
      const variant = listing.variant || listing.selectedVariant || listing.variantV2
                   || listing.listingVariant || {};
      const selectedOptions = variant.selectedOptions || variant.options || [];

      // packingSlipAttributes fallback for variant info
      const packingAttrs = listing.packingSlipAttributes || variant.packingSlipAttributes || [];
      const effectiveOptions = selectedOptions.length > 0 ? selectedOptions : packingAttrs;

      const variations = {};
      effectiveOptions.forEach(o => { if (o.name) variations[o.name] = o.value || ''; });

      // Priority: selectedOptions → packingAttrs → CSV title (, Color, Size) → bracket [Size]
      const csvVariant   = parseCSVTitle(productTitle);
      const titleBracket = csvVariant ? '' : extractTitleVariant(productTitle);
      const cleanTitle   = csvVariant?.cleanTitle || stripTitleVariant(productTitle) || productTitle;

      const csvOpts = csvVariant
        ? [{ name: 'Color', value: csvVariant.color }, { name: 'Size', value: csvVariant.size }]
        : [];
      const parseOptions = effectiveOptions.length > 0 ? effectiveOptions
        : (csvOpts.length > 0 ? csvOpts
          : (titleBracket ? [{ name: 'Variant', value: titleBracket }] : []));

      const variantTitle = variant.title
        || (packingAttrs.length > 0 ? packingAttrs.map(a => a.value).filter(Boolean).join(' / ') : '')
        || (csvVariant ? `${csvVariant.color} / ${csvVariant.size}` : '')
        || titleBracket;

      return [{
        sku: listingId,
        listing_id: listing.id || listing.listingId || listing.lid || '',
        sku_name: buildSkuName(cleanTitle, variantTitle),
        name: cleanTitle || 'Whatnot Order',
        quantity: raw.quantity || listing.quantity || 1,
        price: parseMoney(raw.subtotal || listing.price),
        image_url: listing.images?.[0]?.url || listing.image?.url || listing.imageUrl
                   || listing.thumbnailUrl || listing.thumbnail?.url || '',
        product_url: orderUrl,
        variations: Object.keys(variations).length > 0 ? variations
          : (csvVariant ? { Color: csvVariant.color, Size: csvVariant.size } : {}),
        parsed_variants: parseVariants(parseOptions, variantTitle, cleanTitle)
      }];
    }

    // ── Pattern 2: order has an items array (or GraphQL Connection) ──
    let rawItemsList = raw.items || raw.orderItems || raw.lineItems || raw.listingItems;
    // Handle GraphQL Connection: {edges:[{node:{...}}]} or {nodes:[...]}
    if (rawItemsList && !Array.isArray(rawItemsList)) {
      if (rawItemsList.edges)       rawItemsList = rawItemsList.edges.map(e => e && (e.node || e)).filter(Boolean);
      else if (rawItemsList.nodes)  rawItemsList = rawItemsList.nodes;
      else                          rawItemsList = [];
    }
    const rawItems = rawItemsList || [];
    if (rawItems.length > 0) {
      return rawItems.map((item, i) => {
        const it = item.node || item; // unwrap Whatnot's {node:{...}} connection format
        // listing = specific Whatnot auction listing; product = underlying product template
        const listing = it.listing || {};
        const product = it.product || {};
        const listingTitle = listing.title || listing.name || '';
        const productTitle = listingTitle || product.title || product.name
                          || it.listingTitle || it.title || it.name || '';

        const variant = it.variant || it.selectedVariant || it.listingVariant
                     || listing.variant || product.variant || {};
        const selectedOptions = variant.selectedOptions || variant.options
                             || product.selectedOptions || listing.selectedOptions || [];

        // packingSlipAttributes on listing or product
        const packingAttrs = it.packingSlipAttributes || listing.packingSlipAttributes
                          || product.packingSlipAttributes || [];
        const effectiveOptions = selectedOptions.length > 0 ? selectedOptions : packingAttrs;

        const variations = {};
        effectiveOptions.forEach(o => { if (o.name) variations[o.name] = o.value || ''; });

        // Priority: selectedOptions → packingAttrs → CSV title (, Color, Size) → bracket [Size]
        const csvVariant   = parseCSVTitle(productTitle);
        const titleBracket = csvVariant ? '' : extractTitleVariant(productTitle);
        const cleanTitle   = csvVariant?.cleanTitle || stripTitleVariant(productTitle) || productTitle;

        const csvOpts = csvVariant
          ? [{ name: 'Color', value: csvVariant.color }, { name: 'Size', value: csvVariant.size }]
          : [];
        const parseOptions = effectiveOptions.length > 0 ? effectiveOptions
          : (csvOpts.length > 0 ? csvOpts
            : (titleBracket ? [{ name: 'Variant', value: titleBracket }] : []));

        const variantTitle = variant.title
          || (packingAttrs.length > 0 ? packingAttrs.map(a => a.value).filter(Boolean).join(' / ') : '')
          || (csvVariant ? `${csvVariant.color} / ${csvVariant.size}` : '')
          || titleBracket;

        // Image: prefer listing images, then product image
        const imageUrl = listing.images?.[0]?.url || listing.image?.url
                      || product.image?.url || product.images?.[0]?.url
                      || it.image?.url || it.imageUrl || it.thumbnailUrl || '';

        return {
          sku: it.id || listing.id || it.listingId || `${raw.id}-${i}`,
          listing_id: listing.id || it.listingId || '',
          sku_name: buildSkuName(cleanTitle, variantTitle),
          name: cleanTitle || 'Whatnot Item',
          quantity: it.quantity || 1,
          price: parseMoney(it.price || it.subtotal || it.listingPurchasePrice),
          image_url: imageUrl,
          product_url: orderUrl,
          variations: Object.keys(variations).length > 0 ? variations
            : (csvVariant ? { Color: csvVariant.color, Size: csvVariant.size } : {}),
          parsed_variants: parseVariants(parseOptions, variantTitle, cleanTitle)
        };
      });
    }

    // ── Pattern 3: minimal fallback ──
    const title = raw.productTitle || raw.title || raw.description || 'Whatnot Order';
    return [{
      sku: raw.id,
      sku_name: title,
      name: title,
      quantity: raw.quantity || 1,
      price: parseMoney(raw.subtotal || raw.price || raw.total),
      image_url: raw.productImage?.url || raw.imageUrl || raw.image?.url
                 || raw.thumbnail?.url || raw.thumbnailUrl || '',
      product_url: orderUrl,
      variations: {},
      parsed_variants: parseVariants([], '', title)
    }];
  }

  // ── Order builder ──
  function buildOrder(raw) {
    if (!raw || !raw.id) return null;

    const orderNum = raw.orderNumber || raw.order_number || decodeWhatnotId(raw.id);
    const orderId = orderNum ? `WN-${orderNum}` : `WN-${raw.id}`;

    const addr = raw.shippingAddress || raw.shipping_address || raw.address || {};
    const buyer = raw.buyer || raw.customer || raw.user || {};
    const customerName = addr.fullName || addr.full_name
                        || buyer.fullName || buyer.full_name
                        || [buyer.firstName, buyer.lastName].filter(Boolean).join(' ')
                        || '';

    // ── Shipment data nested inside myOrder ──
    const shipment = raw.shipment || raw.sellerShipment || raw.myShipment || {};
    // shipmentId lives on each ITEM node (myOrder.items.edges[].node.shipmentId)
    // Note: Whatnot returns shipmentId as a plain number in JSON, so always convert to string
    let itemShipmentId = String(raw.shipmentId || raw.sellerShipmentId || '');
    if (!itemShipmentId || itemShipmentId === '0') {
      const rawItems = raw.items;
      let firstItemNode = null;
      if (rawItems && rawItems.edges && rawItems.edges[0])
        firstItemNode = rawItems.edges[0].node || rawItems.edges[0];
      else if (Array.isArray(rawItems) && rawItems[0])
        firstItemNode = rawItems[0].node || rawItems[0];
      if (firstItemNode) itemShipmentId = String(firstItemNode.shipmentId || '');
    }
    const rawShipmentId = String(shipment.id || itemShipmentId || '');
    const shipmentNumId = decodeWhatnotId(rawShipmentId)
                       || (/^\d+$/.test(rawShipmentId) ? rawShipmentId : '');
    const labelUrl = shipment.fileUrl || shipment.bundleFileUrl
                  || shipment.labelUrl || shipment.shippingLabelUrl || shipment.shippingLabelUri
                  || shipment.printLabelUrl || shipment.pdfUrl || shipment.labelPdfUrl
                  || shipment.label?.url || shipment.label?.pdfUrl || shipment.shippingLabel?.url || '';
    const trackingNumber = shipment.trackingNumber || shipment.trackingCode
                        || shipment.tracking || shipment.trackingId || raw.trackingNumber || '';
    const shipmentPageUrl = shipmentNumId ? `https://www.whatnot.com/dashboard/shipments/${shipmentNumId}` : '';

    return {
      platform: 'Whatnot',
      order_id: orderId,
      _raw_id: raw.id,
      customer_name: customerName,
      buyer_username: buyer.username || buyer.handle || '',
      email: buyer.email || '',
      address_1: addr.line1 || addr.address1 || addr.street || '',
      address_2: addr.line2 || addr.address2 || '',
      city: addr.city || '',
      state: addr.state || addr.province || addr.region || '',
      country: addr.country || addr.countryCode || addr.country_code || 'US',
      zipcode: addr.zipcode || addr.zip || addr.postalCode || addr.postal_code || '',
      phone_number: addr.phone || buyer.phone || '',
      note: raw.note || raw.buyerNote || raw.buyer_note || '',
      // Prefer seller net earnings over buyer price
      // Log which field was used so we can confirm the correct field name
      revenue: (() => {
        const earn = raw.sellerEarnings || raw.netEarnings || raw.earnedAmount ||
                     raw.sellerAmount   || raw.earnings;
        if (earn) {
          const field = raw.sellerEarnings ? 'sellerEarnings' : raw.netEarnings ? 'netEarnings' :
                        raw.earnedAmount   ? 'earnedAmount'   : raw.sellerAmount ? 'sellerAmount' : 'earnings';
          console.log('[VH Whatnot] revenue from', field, '=', parseMoney(earn), '(subtotal was', parseMoney(raw.subtotal), ')');
          return parseMoney(earn);
        }
        return parseMoney(raw.subtotal);
      })(),
      shipping_cost: parseMoney(raw.shippingPrice || raw.shipping),
      status: mapStatus(raw.status),
      date_created: parseDate(raw.createdAt || raw.created_at || raw.purchasedAt || raw.soldAt),
      label_link: labelUrl || shipmentPageUrl,
      tracking_number: trackingNumber,
      _shipmentId: shipmentNumId,
      items: buildItems(raw)
    };
  }

  function mergeOrder(existing, updated) {
    const result = Object.assign({}, existing);
    for (const k of Object.keys(updated)) {
      const v = updated[k];
      const blank = v === '' || v === 0 || (Array.isArray(v) && v.length === 0)
                 || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
      if (!blank) result[k] = v;
    }
    return result;
  }

  function upsertOrder(raw) {
    const order = buildOrder(raw);
    if (!order) return;
    const existing = _orders.get(order.order_id);
    _orders.set(order.order_id, existing ? mergeOrder(existing, order) : order);
    _lastOrderId = order.order_id;
    // Track listing_id → order_id for variant enrichment via listing GQL
    (order.items || []).forEach(function (item) {
      if (item.listing_id) _listingToOrder.set(item.listing_id, order.order_id);
    });
  }

  function notify() {
    window.dispatchEvent(new CustomEvent('vh:wn:update', { detail: { count: _orders.size } }));
  }

  // ── Parse formatted dollar string like "$15.44" or "-$1.44" → number ──
  function parseReceiptAmount(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v / 100; // assume cents
    const str = String(v).trim();
    const sign = str.startsWith('-') ? -1 : 1;
    const num = parseFloat(str.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? 0 : sign * num;
  }

  // ── Extract net earnings from orderItemSellerReceipt GQL data ──
  function processSellerReceipt(receipt) {
    if (!receipt) return;

    let netEarnings = null;

    // Try common direct field names
    const directFields = ['netEarnings', 'totalEarnings', 'sellerEarnings', 'earnings', 'net'];
    for (const f of directFields) {
      if (receipt[f] != null) {
        const v = receipt[f];
        netEarnings = (typeof v === 'object') ? parseReceiptAmount(v.amount) : parseReceiptAmount(v);
        if (netEarnings > 0) break;
      }
    }

    // Try receipt line items array: find the item whose label includes "net" or "earning"
    if (netEarnings === null) {
      const lines = receipt.receiptLines || receipt.lineItems || receipt.items
                 || receipt.mDebits || receipt.deductions || receipt.receiptItems;
      if (Array.isArray(lines)) {
        for (const item of lines) {
          const lbl = (item.label || item.title || item.name || '').toLowerCase();
          if (lbl.includes('net') || lbl.includes('earning') || lbl.includes('total payout')) {
            netEarnings = parseReceiptAmount(item.amount);
            break;
          }
        }
        // Fallback: sum itemPurchasePrice + all deductions
        if (netEarnings === null && receipt.itemPurchasePrice) {
          let total = parseReceiptAmount(receipt.itemPurchasePrice.amount);
          lines.forEach(d => { total += parseReceiptAmount(d.amount); });
          if (total > 0) netEarnings = total;
        }
      }
    }

    // Fallback: price - deductions
    if (netEarnings === null && receipt.itemPurchasePrice) {
      let total = parseReceiptAmount(receipt.itemPurchasePrice.amount);
      const debits = receipt.mDebits || receipt.deductions || receipt.fees || [];
      if (Array.isArray(debits)) debits.forEach(d => { total += parseReceiptAmount(d.amount); });
      if (total > 0) netEarnings = total;
    }

    if (!netEarnings || netEarnings <= 0) return;

    const orderId = _lastOrderId;
    if (!orderId) return;
    const existing = _orders.get(orderId);
    if (!existing) return;

    existing.net_earnings = netEarnings;
    existing.revenue = netEarnings; // overwrite with real net, not buyer price
    _orders.set(orderId, existing);
    console.log('[VH Whatnot] Net earnings for', orderId, ':', netEarnings);
    notify();
  }

  // ── Merge shipping address from shipment data into an existing captured order ──
  function processShipment(shipment) {
    if (!shipment || !shipment.id) return;
    // shipment.address uses {addressLine1, postalCode, countryCode} naming
    // also try direct top-level fields (addressLine1, addressCity, etc.)
    const addrObj = shipment.shippingAddress || shipment.shipping_address || shipment.address || {};
    // Normalise to uniform field names
    const addr = {
      line1:       addrObj.line1 || addrObj.address1 || addrObj.street || addrObj.addressLine1 || shipment.addressLine1 || '',
      line2:       addrObj.line2 || addrObj.address2 || addrObj.addressLine2 || shipment.addressLine2 || '',
      city:        addrObj.city  || addrObj.addressCity  || shipment.addressCity  || '',
      state:       addrObj.state || addrObj.province || addrObj.region || addrObj.addressState || shipment.addressState || '',
      zipcode:     addrObj.zipcode || addrObj.zip || addrObj.postalCode || addrObj.postal_code || addrObj.addressPostalCode || shipment.addressPostalCode || '',
      country:     addrObj.country || addrObj.countryCode || addrObj.country_code || addrObj.addressCountryCode || shipment.addressCountryCode || 'US',
      fullName:    addrObj.fullName || addrObj.full_name || shipment.fullName || '',
      phone:       addrObj.phone || addrObj.phoneNumber || shipment.addressPhoneNumber || '',
    };

    // Collect all order references inside this shipment
    const orderRefs = [];
    if (shipment.order && shipment.order.id) orderRefs.push(shipment.order);
    const lists = [shipment.orders, shipment.orderItems, shipment.includedOrders];
    lists.forEach(list => {
      if (!list) return;
      const nodes = list.edges ? list.edges.map(e => e && e.node).filter(Boolean)
                  : (list.nodes || (Array.isArray(list) ? list : []));
      nodes.forEach(n => {
        if (n && n.id) orderRefs.push(n);
        if (n && n.order && n.order.id) orderRefs.push(n.order);
      });
    });
    // If no order refs found via GQL structure, scan captured orders by shipmentId
    if (orderRefs.length === 0) {
      const shipId = decodeWhatnotId(shipment.id) || (typeof shipment.id === 'string' && /^\d+$/.test(shipment.id) ? shipment.id : '');
      if (shipId) {
        for (const order of _orders.values()) {
          if (order._shipmentId === shipId || order._shipmentId === shipment.id) {
            orderRefs.push({ id: order._raw_id, orderNumber: order.order_id.replace('WN-', '') });
          }
        }
      }
      if (orderRefs.length === 0) return;
    }

    const hasAddr = !!(addr.line1);

    // Collect label & tracking from this shipment
    const shipNumId = decodeWhatnotId(shipment.id) || (typeof shipment.id === 'string' && /^\d+$/.test(shipment.id) ? shipment.id : '');
    const labelUrl = shipment.fileUrl || shipment.bundleFileUrl
                  || shipment.labelUrl || shipment.shippingLabelUrl || shipment.shippingLabelUri
                  || shipment.printLabelUrl || shipment.label?.url || shipment.label?.pdfUrl || '';
    const trackingNum = shipment.trackingNumber || shipment.trackingCode
                     || shipment.tracking || shipment.trackingId || '';
    const shipmentPage = shipNumId ? `https://www.whatnot.com/dashboard/shipments/${shipNumId}` : '';

    orderRefs.forEach(ref => {
      // If the embedded order has product data, upsert it (with address merged in)
      if (ref.listing || ref.subtotal || ref.status) {
        const refWithAddr = (hasAddr && !ref.shippingAddress)
          ? Object.assign({}, ref, { shippingAddress: { line1: addr.line1, line2: addr.line2, city: addr.city, state: addr.state, zipcode: addr.zipcode, country: addr.country, fullName: addr.fullName } })
          : ref;
        upsertOrder(refWithAddr);
      }

      const orderNum = ref.orderNumber || ref.order_number || decodeWhatnotId(ref.id);
      if (!orderNum) return;
      const orderId = `WN-${orderNum}`;
      const existing = _orders.get(orderId);
      if (!existing) return;

      const updated = Object.assign({}, existing);
      if (hasAddr) {
        updated.address_1 = addr.line1   || existing.address_1;
        updated.address_2 = addr.line2   || existing.address_2 || '';
        updated.city      = addr.city    || existing.city;
        updated.state     = addr.state   || existing.state;
        updated.zipcode   = addr.zipcode || existing.zipcode;
        updated.country   = addr.country || existing.country || 'US';
        if (addr.fullName && !updated.customer_name) updated.customer_name = addr.fullName;
        if (addr.phone) updated.phone_number = addr.phone;
      }

      // Always capture label URL and tracking — prefer real PDF over page URL
      if (labelUrl) updated.label_link = labelUrl;
      else if (!updated.label_link && shipmentPage) updated.label_link = shipmentPage;
      if (trackingNum && !updated.tracking_number) updated.tracking_number = trackingNum;

      _orders.set(orderId, updated);
      console.log('[VH Whatnot] Merged shipping for order', orderId, '→', updated.address_1, '| label:', updated.label_link?.slice(0, 60));
    });

    // ── Cross-tab relay: broadcast to orders tabs when running on a shipment page ──
    // The shipment page's scraper found the real fileUrl; relay it back to the
    // orders tab where _orders is populated so label_link gets updated there too.
    if (window.location.pathname && window.location.pathname.includes('/dashboard/shipments') &&
        (labelUrl || trackingNum)) {
      try {
        chrome.runtime.sendMessage({
          type: 'WN_SHIPMENT_RELAYED',
          payload: {
            id: shipment.id,
            fileUrl: labelUrl,
            bundleFileUrl: shipment.bundleFileUrl || '',
            trackingNumber: trackingNum,
            trackingId: shipment.trackingId || '',
            orders: orderRefs.slice(0, 20).map(function (r) {
              return {
                id: r.id || '',
                orderNumber: r.orderNumber || r.order_number || ''
              };
            }).filter(function (r) { return r.id || r.orderNumber; })
          }
        });
      } catch (e) {}
    }
  }

  // ── Process GraphQL response ──
  function processGQL(data) {
    if (!data || !data.data) return;
    const d = data.data;

    // Capture seller username from me query
    const me = d.me || {};
    if (me.username && !_sellerUsername) {
      _sellerUsername = me.username;
      chrome.storage.local.set({ whatnotUsername: _sellerUsername });
      console.log('[VH Whatnot] Seller username:', _sellerUsername);
    }

    // Single order — try many possible field names (peek panel uses different query names)
    const SINGLE_ORDER_KEYS = [
      'myOrder','sellerOrder','order','soldOrder',
      'orderDetail','viewOrder','sellerOrderDetail','orderNode','node'
    ];
    SINGLE_ORDER_KEYS.forEach(k => {
      const v = d[k];
      if (v && v.id && (v.orderNumber || v.order_number || v.subtotal || v.status || v.listing)) {
        upsertOrder(v);
      }
    });

    // Order list (from me.* or top-level)
    // Whatnot uses non-standard edges: [{id,...}] instead of [{node:{id,...}}]
    function processEdgeList(list) {
      if (!list) return;
      if (list.edges) list.edges.forEach(e => {
        if (!e) return;
        const n = e.node || e; // handle both {node:{}} and direct edge formats
        if (n && n.id && n !== list) upsertOrder(n);
      });
      if (list.nodes) list.nodes.forEach(n => n && n.id && upsertOrder(n));
      if (Array.isArray(list)) list.forEach(o => o && o.id && upsertOrder(o));
    }
    [
      me.soldOrders, me.sellerOrders, me.orders, me.myOrders,
      d.soldOrders, d.sellerOrders, d.orders, d.myOrders
    ].forEach(processEdgeList);

    // Generic fallback: scan all top-level keys for anything order-shaped
    const SKIP_KEYS = new Set(SINGLE_ORDER_KEYS);
    Object.keys(d).forEach(key => {
      if (SKIP_KEYS.has(key) || key === 'me') return;
      const val = d[key];
      if (!val || typeof val !== 'object') return;
      // Single order: has id + (orderNumber OR subtotal) + (status OR listing)
      if (val.id && (val.orderNumber || val.order_number || val.subtotal)
                 && (val.status || val.listing || val.buyer)) {
        upsertOrder(val);
      }
      // List of orders — handle both {node:{}} and direct edge formats
      if (val.edges) {
        val.edges.forEach(e => {
          if (!e) return;
          const n = e.node || e; // Whatnot: direct edge, standard GraphQL: e.node
          if (n && n.id && n !== val && (n.orderNumber || n.order_number || n.subtotal || n.buyer)) upsertOrder(n);
        });
      }
      if (val.nodes) {
        val.nodes.forEach(n => {
          if (n && n.id && (n.orderNumber || n.order_number || n.subtotal)) upsertOrder(n);
        });
      }
    });

    // ── Seller receipt / net earnings ──
    if (d.orderItemSellerReceipt) processSellerReceipt(d.orderItemSellerReceipt);
    if (d.sellerReceipt) processSellerReceipt(d.sellerReceipt);

    // ── Shipment data (from dashboard/shipments) → merge address into captured orders ──
    ['shipment', 'sellerShipment', 'myShipment'].forEach(k => {
      if (d[k] && d[k].id) processShipment(d[k]);
    });
    [me.shipments, me.sellerShipments, d.shipments, d.sellerShipments].forEach(list => {
      if (!list) return;
      if (list.edges) list.edges.forEach(e => e && e.node && processShipment(e.node));
      if (list.nodes) list.nodes.forEach(n => n && processShipment(n));
      if (Array.isArray(list)) list.forEach(s => s && processShipment(s));
    });

    // ── Listing data → variant enrichment ──
    // Fired by __vh_wn_gql_query__ in autoEnrichOrders when size/color is missing.
    // Whatnot may return the listing under different query field names.
    ['listing', 'getListing', 'listingDetail', 'listingById', 'listingNode'].forEach(function (k) {
      const l = d[k];
      if (!l || !l.id) return;
      console.log('[VH Whatnot] Listing GQL received, id:', l.id, '| keys:', Object.keys(l).join(', '));
      const orderId = _listingToOrder.get(l.id);
      if (!orderId) return;
      const existing = _orders.get(orderId);
      if (!existing) return;

      const packingAttrs = l.packingSlipAttributes || [];
      const selectedOpts = (l.variant && (l.variant.selectedOptions || l.variant.options)) || [];
      const effectiveOpts = selectedOpts.length > 0 ? selectedOpts : packingAttrs;
      if (effectiveOpts.length === 0) {
        console.log('[VH Whatnot] Listing GQL for', orderId, '— no packingSlipAttributes or selectedOptions');
        return;
      }

      const variantTitle = (l.variant && l.variant.title)
        || packingAttrs.map(function (a) { return a.value; }).filter(Boolean).join(' / ')
        || '';
      const productTitle = l.title || (existing.items && existing.items[0] && existing.items[0].name) || '';
      const parsed = parseVariants(effectiveOpts, variantTitle, productTitle);

      const updatedOrder = Object.assign({}, existing);
      if (updatedOrder.items && updatedOrder.items.length > 0) {
        const vars = {};
        effectiveOpts.forEach(function (o) { if (o.name) vars[o.name] = o.value || ''; });
        updatedOrder.items = updatedOrder.items.map(function (item) {
          if (item.listing_id && item.listing_id !== l.id) return item;
          return Object.assign({}, item, {
            parsed_variants: parsed,
            variations: Object.keys(vars).length > 0 ? vars : item.variations
          });
        });
      }
      _orders.set(orderId, updatedOrder);
      console.log('[VH Whatnot] Variant enriched for', orderId, '→ size:', parsed.size, '| color:', parsed.color);
    });

    notify();
  }

  // ── Listen to CustomEvents from MAIN world (whatnotFetchInterceptor.js) ──
  window.addEventListener('__vh_wn_gql', function (e) {
    try {
      if (e.detail && e.detail.data) {
        // Log top-level keys + first order field names for debugging
        const d = e.detail.data.data || {};
        const topKeys = Object.keys(d);
        console.log('[VH Whatnot] GQL keys:', topKeys.join(', '));
        topKeys.forEach(k => {
          const v = d[k];
          if (!v || typeof v !== 'object') return;
          if (v.id && !v.edges && !v.nodes) {
            // Single order or receipt — log full data (up to 1500 chars)
            console.log(`[VH Whatnot] d.${k}:`, JSON.stringify(v).slice(0, 1500));
          }
        });
        // Log first edge of me.orders to verify listing/product data is present
        const meObj = d.me || {};
        if (meObj.orders && meObj.orders.edges && meObj.orders.edges[0]) {
          console.log('[VH Whatnot] me.orders.edges[0]:', JSON.stringify(meObj.orders.edges[0]).slice(0, 2000));
        }
        // ── Deep debug: dump myOrder structure for diagnosis ──
        if (d.myOrder) {
          const mo = d.myOrder;
          // Top-level keys of myOrder
          console.log('[VH Whatnot] myOrder keys:', Object.keys(mo).join(', '));
          // Shipment structure
          const ship = mo.shipment || mo.sellerShipment || mo.myShipment;
          if (ship) {
            console.log('[VH Whatnot] myOrder.shipment keys:', Object.keys(ship).join(', '));
            console.log('[VH Whatnot] myOrder.shipment:', JSON.stringify(ship).slice(0, 800));
          } else {
            console.log('[VH Whatnot] myOrder.shipment: NULL/MISSING');
          }
          // Items structure
          const it = mo.items;
          const itType = Array.isArray(it) ? `array[${it.length}]`
            : (it && typeof it === 'object' ? `object{${Object.keys(it).join(',')}}` : String(it));
          console.log('[VH Whatnot] myOrder.items type:', itType);
          // First item — full dump to see all fields
          let firstItem = null;
          if (it && it.edges && it.edges[0]) firstItem = it.edges[0].node || it.edges[0];
          else if (Array.isArray(it) && it[0])  firstItem = it[0].node || it[0];
          if (firstItem) {
            console.log('[VH Whatnot] myOrder.items[0] keys:', Object.keys(firstItem).join(', '));
            console.log('[VH Whatnot] myOrder.items[0] FULL:', JSON.stringify(firstItem).slice(0, 2000));
            // Log product field specifically for variant detection
            if (firstItem.product) {
              console.log('[VH Whatnot] items[0].product keys:', Object.keys(firstItem.product).join(', '));
              console.log('[VH Whatnot] items[0].product:', JSON.stringify(firstItem.product).slice(0, 1000));
            }
            if (firstItem.listing) {
              console.log('[VH Whatnot] items[0].listing keys:', Object.keys(firstItem.listing).join(', '));
              console.log('[VH Whatnot] items[0].listing.title:', firstItem.listing.title);
              // Log packingSlipAttributes if present
              if (firstItem.listing.packingSlipAttributes)
                console.log('[VH Whatnot] listing.packingSlipAttributes:', JSON.stringify(firstItem.listing.packingSlipAttributes));
            }
            console.log('[VH Whatnot] items[0].shipmentId:', firstItem.shipmentId);
          }
        }
        processGQL(e.detail.data);
      }
    } catch (ex) {
      console.warn('[VH Whatnot] processGQL error:', ex);
    }
  });

  // ── Public API ──
  window.VHWhatnotScraper = {
    getOrders:   function () { return Array.from(_orders.values()); },
    getCount:    function () { return _orders.size; },
    getUsername: function () { return _sellerUsername; },
    clear:       function () { _orders.clear(); notify(); },
    /** Replace an order's label_link (e.g. after uploading to Drive) */
    updateOrderLabel: function (orderId, labelLink) {
      const order = _orders.get(orderId);
      if (order) { order.label_link = labelLink; _orders.set(orderId, order); notify(); }
    },
    /** Dump raw captured orders to console for debugging */
    dump: function () { console.log('[VH Whatnot] Captured orders:', JSON.stringify(Array.from(_orders.values()), null, 2)); }
  };

  chrome.storage.local.get('whatnotUsername', function (r) {
    if (r.whatnotUsername) _sellerUsername = r.whatnotUsername;
  });

  // ── Receive relayed shipment data from background (originally sent by the shipment tab) ──
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'WN_SHIPMENT_RELAYED' && msg.payload) {
      try { processShipment(msg.payload); } catch (e) {}
    }
  });

  console.log('[VH Whatnot] Scraper ready. Call VHWhatnotScraper.dump() to inspect captured orders.');
})();
