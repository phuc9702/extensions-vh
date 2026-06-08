/**
 * VH Whatnot Order Sync - Sync Button
 * Adds a floating sync panel to Whatnot order dashboard pages.
 * Relies on window.VHWhatnotScraper (from whatnotOrderScraper.js).
 */
(function () {
  'use strict';

  if (window.__VH_WHATNOT_SYNC_BTN__) return;
  window.__VH_WHATNOT_SYNC_BTN__ = true;

  const manifest = chrome.runtime.getManifest();
  const API_URL = manifest.api_url || 'https://vhmediaco.app';
  const DRIVE_FOLDER_ID = '11zQeBNHuzRycQomISbAK1WFFceMjX-YZ'; // Shared Drive folder for labels

  // ── JWT helpers (shared with Etsy sync button) ──
  function decodeJWT(token) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(base64).split('').map(c =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
      ).join(''));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  function isAccessTokenExpired(token) {
    if (!token) return true;
    try {
      const decoded = decodeJWT(token);
      return decoded.exp < Date.now() / 1000;
    } catch (e) { return true; }
  }

  async function refreshAccessToken() {
    const { refreshToken } = await chrome.storage.local.get('refreshToken');
    if (!refreshToken) throw new Error('No refresh token. Please login again.');
    const resp = await chrome.runtime.sendMessage({
      type: 'ETSY_REFRESH_TOKEN',
      payload: { url: `${API_URL}/api/token/refresh/`, refreshToken }
    });
    if (!resp?.ok) {
      await chrome.storage.local.remove(['accessToken', 'refreshToken']);
      throw new Error('Session expired. Please login again.');
    }
    return resp.accessToken;
  }

  async function getValidAccessToken() {
    let { accessToken } = await chrome.storage.local.get('accessToken');
    if (!accessToken || isAccessTokenExpired(accessToken)) {
      accessToken = await refreshAccessToken();
    }
    return accessToken;
  }

  // ── Toast notifications ──
  function injectToastStyles() {
    if (document.querySelector('#vh-toast-styles')) return;
    const style = document.createElement('style');
    style.id = 'vh-toast-styles';
    style.textContent = `
      .vh-toast-container{position:fixed;top:20px;right:20px;z-index:999999;animation:vh-ts-in .3s ease-out}
      @keyframes vh-ts-in{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
      @keyframes vh-ts-out{from{transform:translateX(0);opacity:1}to{transform:translateX(100%);opacity:0}}
      .vh-toast{background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.4);min-width:320px;max-width:400px;overflow:hidden;border:1px solid rgba(255,255,255,.1)}
      .vh-toast-success .vh-toast{border-left:4px solid #00c853}
      .vh-toast-warning .vh-toast{border-left:4px solid #ff9800}
      .vh-toast-error   .vh-toast{border-left:4px solid #ff5252}
      .vh-toast-header{display:flex;align-items:center;padding:12px 16px;background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.1)}
      .vh-toast-icon{font-size:20px;margin-right:10px}
      .vh-toast-title{flex:1;font-weight:600;color:#fff;font-size:14px}
      .vh-toast-close{background:none;border:none;color:rgba(255,255,255,.5);font-size:20px;cursor:pointer;padding:0;line-height:1}
      .vh-toast-close:hover{color:#fff}
      .vh-toast-body{padding:12px 16px}
      .vh-toast-line{padding:6px 0;font-size:13px;color:#fff}
      .vh-t-success{color:#69f0ae}.vh-t-skip{color:#ffb74d}.vh-t-error{color:#ff8a80}
      .vh-toast-order-ids{padding:4px 8px;margin:4px 0;background:rgba(105,240,174,.1);border-radius:4px;font-family:monospace;color:#69f0ae;word-break:break-all}
      .vh-toast-skip-ids{background:rgba(255,183,77,.1);color:#ffb74d}
      .vh-toast-errors{margin-top:8px;padding:8px;background:rgba(255,82,82,.1);border-radius:6px;color:#ff8a80}
      .vh-toast-action-btn{display:block;width:100%;margin-top:12px;padding:10px 16px;background:linear-gradient(135deg,#ff416c,#ff4b2b);border:none;border-radius:8px;color:#fff;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
      .vh-toast-action-btn:hover{opacity:.9}
      .vh-toast-progress{height:3px;background:rgba(255,255,255,.1)}
      .vh-toast-progress-bar{height:100%;background:linear-gradient(90deg,#ff416c,#ff4b2b);animation:vh-countdown 5s linear forwards}
      @keyframes vh-countdown{from{width:100%}to{width:0%}}
    `;
    document.head.appendChild(style);
  }

  function showToast(created, skipped, failed, errors = [], syncedIds = [], skippedIds = []) {
    injectToastStyles();
    document.querySelector('.vh-toast-container')?.remove();

    let type = 'success', title = 'Sync Completed', icon = '✅';
    if (failed > 0 || errors.length > 0) { type = 'warning'; title = 'Sync Completed with Issues'; icon = '⚠️'; }
    if (created === 0 && skipped === 0 && failed > 0) { type = 'error'; title = 'Sync Failed'; icon = '❌'; }

    const msgs = [];
    if (created > 0) {
      msgs.push(`<div class="vh-toast-line vh-t-success">✅ ${created} new order(s) created</div>`);
      if (syncedIds.length > 0) {
        const disp = syncedIds.slice(0, 5).join(', ') + (syncedIds.length > 5 ? ` +${syncedIds.length - 5} more` : '');
        msgs.push(`<div class="vh-toast-order-ids"><small>📋 ${disp}</small></div>`);
      }
    }
    if (skipped > 0) {
      msgs.push(`<div class="vh-toast-line vh-t-skip">⏭️ ${skipped} order(s) skipped (duplicate)</div>`);
      if (skippedIds.length > 0) {
        const disp = skippedIds.slice(0, 3).join(', ') + (skippedIds.length > 3 ? ` +${skippedIds.length - 3} more` : '');
        msgs.push(`<div class="vh-toast-order-ids vh-toast-skip-ids"><small>📋 ${disp}</small></div>`);
      }
    }
    if (failed > 0) msgs.push(`<div class="vh-toast-line vh-t-error">❌ ${failed} order(s) failed</div>`);
    if (errors.length > 0) {
      const errMsgs = errors.slice(0, 3).map(e =>
        typeof e === 'string' ? e : (e?.message || e?.error || e?.detail || JSON.stringify(e))
      );
      msgs.push(`<div class="vh-toast-errors"><small>${errMsgs.join('<br>')}</small></div>`);
    }

    const toast = document.createElement('div');
    toast.className = `vh-toast-container vh-toast-${type}`;
    toast.innerHTML = `
      <div class="vh-toast">
        <div class="vh-toast-header">
          <span class="vh-toast-icon">${icon}</span>
          <span class="vh-toast-title">${title}</span>
          <button class="vh-toast-close">&times;</button>
        </div>
        <div class="vh-toast-body">${msgs.join('')}</div>
        <div class="vh-toast-progress"><div class="vh-toast-progress-bar"></div></div>
      </div>`;
    document.body.appendChild(toast);
    toast.querySelector('.vh-toast-close').addEventListener('click', () => dismissToast(toast));
    setTimeout(() => dismissToast(toast), 5000);
  }

  function dismissToast(toast) {
    if (!toast.parentNode) return;
    toast.style.animation = 'vh-ts-out .3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }

  function showLoginRequiredToast() {
    injectToastStyles();
    document.querySelector('.vh-toast-container')?.remove();
    const toast = document.createElement('div');
    toast.className = 'vh-toast-container vh-toast-error';
    toast.innerHTML = `
      <div class="vh-toast">
        <div class="vh-toast-header">
          <span class="vh-toast-icon">🔐</span>
          <span class="vh-toast-title">Login Required</span>
          <button class="vh-toast-close">&times;</button>
        </div>
        <div class="vh-toast-body">
          <div class="vh-toast-line">Your session has expired or you are not logged in.</div>
          <div class="vh-toast-line vh-t-skip">Click the VH icon in your browser toolbar to login.</div>
        </div>
      </div>`;
    document.body.appendChild(toast);
    toast.querySelector('.vh-toast-close').addEventListener('click', () => dismissToast(toast));
  }

  function showAccountNotFoundToast(accountName) {
    injectToastStyles();
    document.querySelector('.vh-toast-container')?.remove();
    const toast = document.createElement('div');
    toast.className = 'vh-toast-container vh-toast-error';
    toast.innerHTML = `
      <div class="vh-toast">
        <div class="vh-toast-header">
          <span class="vh-toast-icon">❌</span>
          <span class="vh-toast-title">Account Not Found</span>
          <button class="vh-toast-close">&times;</button>
        </div>
        <div class="vh-toast-body">
          <div class="vh-toast-line vh-t-error">Account "<strong>${accountName || 'unknown'}</strong>" not found on VH server.</div>
          <div class="vh-toast-line vh-t-skip">Please add this Whatnot account on VH website first.</div>
          <a href="https://vhmediaco.app/ecommerce/account" target="_blank" class="vh-toast-action-btn">
            ➕ Add Account on VH
          </a>
        </div>
      </div>`;
    document.body.appendChild(toast);
    toast.querySelector('.vh-toast-close').addEventListener('click', () => dismissToast(toast));
  }

  function showEndpointNotFoundToast() {
    injectToastStyles();
    document.querySelector('.vh-toast-container')?.remove();
    const toast = document.createElement('div');
    toast.className = 'vh-toast-container vh-toast-warning';
    toast.innerHTML = `
      <div class="vh-toast">
        <div class="vh-toast-header">
          <span class="vh-toast-icon">🔧</span>
          <span class="vh-toast-title">Backend chưa có endpoint</span>
          <button class="vh-toast-close">&times;</button>
        </div>
        <div class="vh-toast-body">
          <div class="vh-toast-line vh-t-error">Endpoint <strong>/api/ecommerce/whatnot/sync-orders/</strong> chưa được tạo trên server.</div>
          <div class="vh-toast-line vh-t-skip">Yêu cầu backend developer thêm endpoint này.</div>
        </div>
      </div>`;
    document.body.appendChild(toast);
    toast.querySelector('.vh-toast-close').addEventListener('click', () => dismissToast(toast));
  }

  // ── Helpers ──
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Resolves on next vh:wn:update OR after timeout — whichever comes first
  function waitForGQL(timeout) {
    return new Promise(resolve => {
      let done = false;
      const cleanup = () => { if (done) return; done = true; window.removeEventListener('vh:wn:update', h); clearTimeout(t); };
      const h = () => { cleanup(); resolve(); };
      const t = setTimeout(() => { cleanup(); resolve(); }, timeout);
      window.addEventListener('vh:wn:update', h, { once: true });
    });
  }

  // Poll fn() every `interval` ms until it returns truthy or `timeout` expires
  async function pollFor(fn, timeout, interval) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  // Waits until the specific order has a real shipping-label PDF URL, or timeout
  function waitForLabelLink(orderId, timeout) {
    const isReal = url => !!(url && (
      url.includes('goshipo') || url.includes('shippo') ||
      url.includes('easypost') || url.includes('.pdf') ||
      url.includes('label')
    ));
    return new Promise(resolve => {
      let done = false;
      const getOrder = () => (window.VHWhatnotScraper?.getOrders() ?? [])
        .find(o => o._raw_id === orderId || o.order_id === `WN-${orderId}`);
      const check = () => {
        const o = getOrder();
        if (isReal(o?.label_link)) { cleanup(true); }
      };
      const cleanup = (found = false) => {
        if (done) return; done = true;
        window.removeEventListener('vh:wn:update', check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => cleanup(false), timeout);
      if (isReal(getOrder()?.label_link)) { cleanup(true); return; }
      window.addEventListener('vh:wn:update', check);
    });
  }

  // ── XPath helpers ──
  function xpathFirst(expr, ctx) {
    try {
      const r = document.evaluate(expr, ctx || document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue || null;
    } catch (e) { return null; }
  }

  function xpathAll(expr, ctx) {
    try {
      const r = document.evaluate(expr, ctx || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < r.snapshotLength; i++) nodes.push(r.snapshotItem(i));
      return nodes;
    } catch (e) { return []; }
  }

  // Find the peek/drawer panel containing the order ID text
  function findPeekPanel(orderId) {
    return xpathFirst(
      `//*[
        contains(translate(@class,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'peek') or
        contains(translate(@class,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'drawer') or
        contains(translate(@class,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'slide') or
        @role='dialog'
      ][contains(.,'${orderId}')]`
    ) || xpathFirst(
      `//*[contains(@style,'position: fixed') or contains(@style,'position:fixed')][contains(.,'${orderId}')]`
    );
  }

  // Product title/image link inside the peek panel
  function findPeekTitleLink(orderId) {
    const panel = findPeekPanel(orderId);
    if (!panel) return null;
    return xpathFirst(
      `.//a[
        (contains(@href,'/dashboard/orders/') or contains(@href,'/listing/'))
        and not(contains(@href,'/user/'))
        and not(contains(@href,'/profile/'))
        and not(contains(@href,'support'))
        and normalize-space(.)!=''
      ]`, panel
    ) || xpathFirst('.//img[contains(@src,"whatnot")]', panel);
  }

  // "View Shipment" link visible in the open peek panel
  function findViewShipmentLink() {
    return xpathFirst('//a[contains(@href,"/dashboard/shipments/")]');
  }

  // Dispatch a direct GQL query through the MAIN-world interceptor
  function fireGQL(query) {
    window.dispatchEvent(new CustomEvent('__vh_wn_gql_query__', {
      detail: { body: { query } }
    }));
  }

  // ── Check which order IDs already exist in VHapp ──
  async function checkExistingOrders(orderIds) {
    console.log('[VH Check] Sending IDs:', orderIds);
    try {
      let token;
      try { token = await getValidAccessToken(); } catch { token = null; }
      const checkUrl = `${API_URL}/api/ecommerce/whatnot/check-orders/`;
      const isLocalhost = API_URL.includes('localhost') || API_URL.includes('127.0.0.1');
      console.log('[VH Check] URL:', checkUrl, '| localhost:', isLocalhost, '| token:', token ? token.slice(0,20)+'...' : 'NONE');
      let data;
      if (isLocalhost) {
        const res = await fetch(checkUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ order_ids: orderIds })
        });
        console.log('[VH Check] localhost response status:', res.status);
        if (!res.ok) return new Set();
        data = await res.json();
      } else {
        const resp = await chrome.runtime.sendMessage({
          type: 'ETSY_API_POST',
          payload: { url: checkUrl, data: { order_ids: orderIds }, token }
        });
        console.log('[VH Check] SW response:', resp?.ok, resp?.status, resp?.body?.slice?.(0, 200));
        if (!resp?.ok) { console.warn('[VH Check] SW not ok, status:', resp?.status); return new Set(); }
        try { data = JSON.parse(resp.body || '{}'); } catch { data = {}; }
      }
      console.log('[VH Check] existing from server:', data.existing);
      const result = new Set((data.existing || []).map(String));
      console.log('[VH Check] existingIds Set size:', result.size, [...result]);
      return result;
    } catch (e) {
      console.warn('[VH Check] checkExistingOrders failed:', e.message);
      return new Set();
    }
  }

  // ── Auto-enrich: click every order row to capture full details ──
  async function autoEnrichOrders(onProgress, onStatus, existingIds = new Set()) {
    const seen = new Set();
    const targets = [];

    // XPath 1: rows in the orders table body
    for (const row of xpathAll(
      '//tbody[@data-testid="orders-table-body"]//tr[contains(.,"Order #")] | //tr[contains(@class,"cursor-pointer") and contains(.,"Order #")]'
    )) {
      const m = (row.textContent || '').match(/Order\s*#(\d{6,})/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); targets.push({ el: row, orderId: m[1] }); }
    }

    // XPath 2: explicit order links
    if (targets.length === 0) {
      for (const el of xpathAll('//a[contains(@href,"/dashboard/orders/")]')) {
        const m = (el.getAttribute('href') || '').match(/\/dashboard\/orders\/(\d{6,})/);
        if (m && !seen.has(m[1])) { seen.add(m[1]); targets.push({ el, orderId: m[1] }); }
      }
    }

    // XPath 3: text-node fallback — walk up to nearest clickable ancestor
    if (targets.length === 0) {
      for (const tn of xpathAll('//text()[contains(.,"Order #")]')) {
        const m = (tn.textContent || '').match(/Order\s*#(\d{6,})/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        let el = tn.parentElement;
        for (let s = 0; el && s < 10; s++, el = el.parentElement) {
          const tag = (el.tagName || '').toUpperCase();
          if (tag === 'TR' || tag === 'A' || tag === 'BUTTON') break;
          if (el.getAttribute('role') === 'button' || el.getAttribute('tabindex') != null) break;
        }
        if (el && el !== document.body) targets.push({ el, orderId: m[1] });
      }
    }

    console.log(`[VH Whatnot] autoEnrichOrders: found ${targets.length} rows, existingIds:`, [...existingIds]);
    if (targets.length === 0) return 0;

    // "Real" shipping-label PDF (as opposed to the shipment-page URL fallback)
    const isRealLabel = url => !!(url && (
      url.includes('goshipo') || url.includes('shippo') ||
      url.includes('easypost') || url.includes('.pdf') || url.includes('label')
    ));
    const getOrder = id => (window.VHWhatnotScraper?.getOrders() ?? [])
      .find(o => o._raw_id === id || o.order_id === `WN-${id}`);

    let clicked = 0;
    for (let i = 0; i < targets.length; i++) {
      const { el, orderId } = targets[i];
      onProgress?.(i + 1, targets.length, clicked);

      // Skip orders already in VHapp (checked via API before the loop)
      if (existingIds.has(orderId)) {
        console.log(`[VH Whatnot] Skip (already in VHapp): ${orderId}`);
        continue;
      }

      const before = getOrder(orderId);
      const isDriveLabel = url => url && url.includes('drive.google');
      const hasGoodData = before &&
        before.items?.[0]?.name !== 'Whatnot Order' &&
        before.items?.[0]?.image_url &&
        before.address_1 &&
        isDriveLabel(before.label_link);
      if (hasGoodData) continue;

      // Fast-path: đã có goshippo label nhưng chưa upload Drive → chỉ làm Step 5
      if (before?.address_1 && isRealLabel(before?.label_link) && !isDriveLabel(before?.label_link)) {
        try {
          console.log('[VH Whatnot] Fast Drive upload for', orderId, '(already has goshippo label)');
          const driveRes = await chrome.runtime.sendMessage({
            type: 'UPLOAD_LABEL_TO_DRIVE',
            payload: { pdfUrl: before.label_link, fileName: `WN-${orderId}`, folderId: DRIVE_FOLDER_ID }
          });
          if (driveRes?.ok && driveRes.driveLink) {
            window.VHWhatnotScraper?.updateOrderLabel(`WN-${orderId}`, driveRes.driveLink);
            console.log('[VH Whatnot] Drive link saved (fast path):', driveRes.driveLink);
          } else {
            console.warn('[VH Whatnot] Drive upload failed (fast path):', driveRes?.error);
          }
        } catch (e) {
          console.warn('[VH Whatnot] Drive upload error (fast path):', e.message);
        }
        clicked++;
        continue;
      }

      // ── Step 1: click row → myOrder GQL → basic data + _shipmentId + listing_id ──
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(100);
      el.click();
      await waitForGQL(3000);

      // ── Step 2: direct shipment GQL (fast path — no tab needed) ──
      const s1 = getOrder(orderId);
      if (s1?._shipmentId && !isRealLabel(s1?.label_link)) {
        const gqlId = btoa('ShipmentNode:' + s1._shipmentId);
        fireGQL(`{ shipment(id:"${gqlId}") { id fileUrl bundleFileUrl trackingNumber trackingId status orders { edges { node { id orderNumber } } } } }`);
        await waitForGQL(2500);
      }

      // ── Step 3: listing GQL for variant (size / color) ──
      const s2 = getOrder(orderId);
      const lid = s2?.items?.[0]?.listing_id;
      const pv  = s2?.items?.[0]?.parsed_variants;
      if (lid && !pv?.size && !pv?.color) {
        fireGQL(`{ listing(id:"${lid}") { id title packingSlipAttributes { name value } variant { title selectedOptions { name value } } } }`);
        await waitForGQL(2500);
      }

      // ── Step 4: open shipment tab if still no real label ──
      // Don't gate on _shipmentId — just look for the "View Shipment" button in the panel.
      // If it's there, the order has a shipment and we can get the label PDF from it.
      if (!isRealLabel(getOrder(orderId)?.label_link)) {
        // Poll up to 4 s — React may not have rendered the link yet
        const shipLink = await pollFor(findViewShipmentLink, 4000, 300);
        if (shipLink) {
          console.log('[VH Whatnot] Opening shipment tab for', orderId, '→', shipLink.getAttribute('href'));
          shipLink.click();
          const got = await waitForLabelLink(orderId, 12000);
          console.log('[VH Whatnot] Label relay for', orderId, ':', got ? '✓ received' : '✗ timed out');
        } else {
          console.log('[VH Whatnot] No View Shipment link for', orderId, '(no shipment or not yet shipped)');
        }
      }

      // ── Step 5: upload label PDF to Drive → replace label_link with Drive link ──
      try {
        const finalSnap = getOrder(orderId);
        const labelUrl = finalSnap?.label_link;
        if (isRealLabel(labelUrl) && !labelUrl.includes('drive.google')) {
          console.log('[VH Whatnot] Uploading label to Drive for', orderId);
          const driveRes = await chrome.runtime.sendMessage({
            type: 'UPLOAD_LABEL_TO_DRIVE',
            payload: { pdfUrl: labelUrl, fileName: `WN-${orderId}`, folderId: DRIVE_FOLDER_ID }
          });
          if (driveRes?.ok && driveRes.driveLink) {
            window.VHWhatnotScraper?.updateOrderLabel(`WN-${orderId}`, driveRes.driveLink);
            console.log('[VH Whatnot] Drive label link saved for', orderId, ':', driveRes.driveLink);
          } else {
            console.warn('[VH Whatnot] Drive upload failed for', orderId, ':', driveRes?.error);
          }
        }
      } catch (e) {
        console.warn('[VH Whatnot] Drive upload error for', orderId, ':', e.message);
      }

      clicked++;
      await sleep(300);
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(300);
    return clicked;
  }

  // ── API call ──
  async function syncOrdersToAPI(orders, tokenOverride, isRetry = false, accountName = '') {
    const stored = await chrome.storage.local.get('accessToken');
    const accessToken = tokenOverride || stored.accessToken;
    const url = `${API_URL}/api/ecommerce/whatnot/sync-orders/`;

    const shopName = (accountName || orders?.[0]?.shop_name || '').trim();
    const payload = shopName
      ? { orders, shop_name: shopName, shopName, account_name: shopName, accountName: shopName }
      : { orders };

    function classifyError(status, body) {
      // 401 → cần đăng nhập lại
      if (status === 401) return 'AUTH';
      // 404 với HTML (Django debug page) → endpoint chưa tồn tại
      if (status === 404 && (body.includes('<html') || body.includes('<!DOCTYPE') || body.includes('Django') || body.includes('URLconf'))) {
        return 'ENDPOINT_NOT_FOUND';
      }
      // 404 với JSON → account không tồn tại
      if (status === 404) return 'ACCOUNT_NOT_FOUND';
      return 'OTHER';
    }

    const isLocalhost = API_URL.includes('localhost') || API_URL.includes('127.0.0.1');

    if (isLocalhost) {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(payload)
      });
      const text = await resp.text();
      if (!resp.ok) {
        const errType = classifyError(resp.status, text);
        if (errType === 'AUTH' && !isRetry) { const tok = await refreshAccessToken(); return syncOrdersToAPI(orders, tok, true, shopName); }
        throw new Error(`${errType}:${resp.status}:${text.slice(0, 200)}`);
      }
      try { return JSON.parse(text); } catch (e) { return { success: true, created: orders.length, skipped: 0, errors: [] }; }
    }

    const resp = await chrome.runtime.sendMessage({
      type: 'ETSY_API_POST',
      payload: { url, data: payload, token: accessToken }
    });
    if (!resp) throw new Error('OTHER:0:No response from service worker');
    if (!resp.ok) {
      const body = resp.body || '';
      const errType = classifyError(resp.status, body);
      if (errType === 'AUTH' && !isRetry) { const tok = await refreshAccessToken(); return syncOrdersToAPI(orders, tok, true, shopName); }
      throw new Error(`${errType}:${resp.status}:${body.slice(0, 200)}`);
    }
    try { return typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body; }
    catch (e) { return { success: true, created: orders.length, skipped: 0, errors: [] }; }
  }

  // ── Create panel ──
  function createSyncButton() {
    if (!window.location.pathname.includes('/dashboard/orders')) return;
    if (document.querySelector('.vh-whatnot-sync-container')) return;

    const container = document.createElement('div');
    container.className = 'vh-whatnot-sync-container vh-etsy-sync-container';
    container.innerHTML = `
      <div class="vh-sync-panel">
        <div class="vh-sync-header">
          <span class="vh-sync-logo">VH</span>
          <span class="vh-sync-title">Whatnot Sync</span>
          <button class="vh-sync-minimize" title="Minimize">−</button>
        </div>
        <div class="vh-sync-body">
          <div class="vh-wn-capture-info">
            <span class="vh-wn-capture-label">Orders captured:</span>
            <span class="vh-wn-capture-count">0</span>
            <button class="vh-btn-link vh-wn-clear-btn" title="Clear captured orders">🗑</button>
          </div>
          <div class="vh-wn-hint" style="font-size:11px;color:#aaa;margin-bottom:8px;">
            Click Sync — it will auto-open each order to capture details, then sync.
          </div>
          <div class="vh-sync-status">
            <span class="vh-status-dot"></span>
            <span class="vh-status-text">Ready</span>
          </div>
          <div class="vh-sync-actions">
            <button class="vh-btn vh-btn-primary vh-wn-sync-btn" title="Sync all captured orders">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/>
                <path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/>
              </svg>
              Sync All
            </button>
          </div>
          <div class="vh-sync-progress" style="display:none;">
            <div class="vh-progress-bar"><div class="vh-progress-fill"></div></div>
            <span class="vh-progress-text">0 / 0</span>
          </div>
          <div class="vh-sync-results" style="display:none;">
            <div class="vh-result-success">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
              </svg>
              <span class="vh-success-count">0</span> new
            </div>
            <div class="vh-result-skipped">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 3l14 9-14 9V3z"/>
              </svg>
              <span class="vh-skipped-count">0</span> dup
            </div>
            <div class="vh-result-failed">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
              <span class="vh-failed-count">0</span> err
            </div>
          </div>
        </div>
        <div class="vh-sync-footer">
          <span class="vh-user-info"></span>
        </div>
      </div>`;

    document.body.appendChild(container);
    initHandlers(container);
    updateCaptureCount();
    checkAuthStatus(container);
  }

  function updateCaptureCount() {
    const el = document.querySelector('.vh-wn-capture-count');
    if (el) el.textContent = window.VHWhatnotScraper?.getCount() ?? 0;
  }

  function initHandlers(container) {
    // Minimize
    let minimized = false;
    container.querySelector('.vh-sync-minimize').addEventListener('click', () => {
      minimized = !minimized;
      container.querySelector('.vh-sync-panel').classList.toggle('vh-minimized', minimized);
      container.querySelector('.vh-sync-minimize').textContent = minimized ? '+' : '−';
    });

    // Clear
    container.querySelector('.vh-wn-clear-btn').addEventListener('click', () => {
      window.VHWhatnotScraper?.clear();
      updateCaptureCount();
      container.querySelector('.vh-status-text').textContent = 'Cleared. Browse orders to re-capture.';
    });

    // Sync
    container.querySelector('.vh-wn-sync-btn').addEventListener('click', syncOrders);
  }

  async function checkAuthStatus(container) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ETSY_CHECK_AUTH' });
      const userInfo = container.querySelector('.vh-user-info');
      if (resp?.data?.isAuthenticated) {
        userInfo.textContent = `👤 ${resp.data.username || 'User'}`;
        userInfo.style.color = '#69f0ae';
      } else {
        userInfo.innerHTML = '<span style="color:#ff8a80">🔐 Not logged in</span>';
      }
    } catch (e) {}
  }

  async function syncOrders() {
    const statusText = document.querySelector('.vh-status-text');
    const statusDot  = document.querySelector('.vh-status-dot');
    const progressEl = document.querySelector('.vh-sync-progress');
    const progressFill = document.querySelector('.vh-progress-fill');
    const progressText = document.querySelector('.vh-progress-text');
    const resultsEl  = document.querySelector('.vh-sync-results');
    const syncBtn    = document.querySelector('.vh-wn-sync-btn');

    syncBtn.disabled = true;

    try {
      // Get account name
      const storage = await chrome.storage.local.get(['whatnotUsername', 'accessToken', 'refreshToken']);
      if (!storage.accessToken && !storage.refreshToken) {
        showLoginRequiredToast();
        throw new Error('Not logged in.');
      }

      const accountName = (window.VHWhatnotScraper?.getUsername() || storage.whatnotUsername || '').trim();

      // ── Phase 1: Auto-open each order row to capture full details via GQL ──
      const hasOrderRows = !!(
        document.querySelector('[data-testid="orders-table-body"] tr') ||
        document.querySelector('tr[class*="cursor-pointer"]')
      );
      if (hasOrderRows) {
        statusDot.className = 'vh-status-dot vh-status-syncing';
        progressEl.style.display = 'flex';
        resultsEl.style.display = 'none';
        progressFill.style.width = '0%';

        // ── Pre-check: lấy danh sách order ID từ DOM, check VHapp trước khi click ──
        const domIds = [];
        for (const el of document.querySelectorAll(
          '[data-testid="orders-table-body"] tr, tr[class*="cursor-pointer"]'
        )) {
          const m = (el.textContent || '').match(/Order\s*#(\d{6,})/);
          if (m) domIds.push(m[1]);
        }
        const uniqueIds = [...new Set(domIds)];
        console.log('[VH Sync] DOM found order IDs:', uniqueIds);
        if (uniqueIds.length > 0) {
          statusText.textContent = `Checking ${uniqueIds.length} orders…`;
          progressText.textContent = '…';
        }
        const existingIds = await checkExistingOrders(uniqueIds);
        const newCount = uniqueIds.length - existingIds.size;
        statusText.textContent = existingIds.size > 0
          ? `${existingIds.size} đã sync, cần fetch ${newCount} đơn mới…`
          : `Fetching ${uniqueIds.length} orders…`;
        progressText.textContent = existingIds.size > 0 ? `skip ${existingIds.size}` : '…';
        await sleep(400);

        await autoEnrichOrders(
          (current, total) => {
            const skipCount = existingIds.size;
            statusText.textContent = `Fetching details… (${current}/${total - skipCount} new)`;
            progressFill.style.width = `${Math.round((current / total) * 50)}%`;
            progressText.textContent = `${current} / ${total}`;
          },
          null,
          existingIds
        );

        statusText.textContent = 'Details fetched. Starting sync…';
        progressFill.style.width = '50%';
        await sleep(300);
      }

      // ── Phase 2: Sync captured orders ──
      let orders = window.VHWhatnotScraper?.getOrders() ?? [];

      if (orders.length === 0) {
        statusText.textContent = 'No orders captured yet. Browse the order list.';
        statusDot.className = 'vh-status-dot vh-status-warning';
        progressEl.style.display = 'none';
        return;
      }

      // Attach account name to each order
      if (accountName) {
        orders = orders.map(o => ({ ...o, shop_name: accountName, account_name: accountName }));
      }

      statusText.textContent = `Syncing ${orders.length} order(s)…`;
      statusDot.className = 'vh-status-dot vh-status-syncing';
      progressEl.style.display = 'flex';
      resultsEl.style.display = 'none';

      let totalCreated = 0, totalSkipped = 0, totalFailed = 0;
      let batchErrors = [], syncedIds = [], skippedIds = [];

      const batchSize = 10;
      const batches = [];
      for (let i = 0; i < orders.length; i += batchSize) {
        batches.push(orders.slice(i, i + batchSize));
      }

      for (let bi = 0; bi < batches.length; bi++) {
        try {
          const result = await syncOrdersToAPI(batches[bi], null, false, accountName);
          totalCreated += result.created || 0;
          totalSkipped += result.skipped || 0;
          if (result.created_order_ids) syncedIds = syncedIds.concat(result.created_order_ids);
          if (result.skipped_order_ids) skippedIds = skippedIds.concat(result.skipped_order_ids);
          if (result.errors?.length) batchErrors = batchErrors.concat(result.errors);
        } catch (e) {
          const msg = e.message || '';
          // Phân loại lỗi theo prefix từ syncOrdersToAPI
          if (msg.startsWith('ENDPOINT_NOT_FOUND') || msg.startsWith('OTHER:404')) {
            showEndpointNotFoundToast(); throw e;
          }
          if (msg.startsWith('AUTH') || msg.includes('Session expired') || msg.includes('refresh token')) {
            showLoginRequiredToast(); throw e;
          }
          if (msg.startsWith('ACCOUNT_NOT_FOUND')) {
            showAccountNotFoundToast(accountName); throw e;
          }
          totalFailed += batches[bi].length;
          console.error('[VH Whatnot] Batch error:', msg);
        }

        // Progress: 50% (after fetch) + up to 50% for sync
        const pct = 50 + Math.round(((bi + 1) / batches.length) * 50);
        progressFill.style.width = `${pct}%`;
        progressText.textContent = `${bi + 1} / ${batches.length} batches`;
      }

      progressEl.style.display = 'none';
      resultsEl.style.display = 'flex';
      document.querySelector('.vh-success-count').textContent = totalCreated;
      document.querySelector('.vh-skipped-count').textContent = totalSkipped;
      document.querySelector('.vh-failed-count').textContent  = totalFailed;

      showToast(totalCreated, totalSkipped, totalFailed, batchErrors, syncedIds, skippedIds);

      if (totalFailed === 0 && batchErrors.length === 0) {
        statusText.textContent = 'Sync completed!';
        statusDot.className = 'vh-status-dot vh-status-success';
      } else {
        statusText.textContent = 'Sync completed with issues';
        statusDot.className = 'vh-status-dot vh-status-warning';
      }

    } catch (e) {
      console.error('[VH Whatnot] Sync error:', e);
      if (!statusText.textContent.includes('Not logged') && !statusText.textContent.includes('No orders')) {
        statusText.textContent = e.message || 'Sync failed';
        statusDot.className = 'vh-status-dot vh-status-error';
      }
      progressEl.style.display = 'none';
    } finally {
      setTimeout(() => { syncBtn.disabled = false; }, 2000);
    }
  }

  // ── Init ──
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createSyncButton);
    } else {
      createSyncButton();
    }

    // Update counter when scraper captures new orders
    window.addEventListener('vh:wn:update', () => updateCaptureCount());

    // Re-inject on SPA navigation (Whatnot is a React app)
    const observer = new MutationObserver(() => {
      const onOrdersPage = window.location.pathname.includes('/dashboard/orders');
      if (onOrdersPage && !document.querySelector('.vh-whatnot-sync-container')) {
        createSyncButton();
      }
      if (!onOrdersPage) {
        document.querySelector('.vh-whatnot-sync-container')?.remove();
      }
    });
    observer.observe(document.body, { childList: true, subtree: false });
  }

  init();
})();
