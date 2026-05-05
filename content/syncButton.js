/**
 * VH Etsy Order Sync - Sync Button
 * Adds a sync button to Etsy order pages
 */

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.__VH_ETSY_SYNC_BTN__) return;
  window.__VH_ETSY_SYNC_BTN__ = true;

  const manifest = chrome.runtime.getManifest();
  const API_URL = manifest.api_url || 'https://vhmediaco.app';

  /**
   * Decode JWT token (giống AliExpress)
   */
  function decodeJWT(token) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(atob(base64).split('').map(c => {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(jsonPayload);
    } catch (e) {
      console.error('JWT decode error:', e);
      return null;
    }
  }

  /**
   * Check if access token is expired
   */
  function isAccessTokenExpired(token) {
    if (!token) return true;
    try {
      const decoded = decodeJWT(token);
      const currentTime = Date.now() / 1000;
      return decoded.exp < currentTime;
    } catch (error) {
      console.error("Invalid token", error);
      return true;
    }
  }

  /**
   * Refresh access token (giống AliExpress)
   */
  async function refreshAccessToken() {
    const { refreshToken } = await chrome.storage.local.get('refreshToken');
    if (!refreshToken) {
      throw new Error('No refresh token. Please login again.');
    }

    const response = await chrome.runtime.sendMessage({
      type: 'ETSY_REFRESH_TOKEN',
      payload: {
        url: `${API_URL}/api/token/refresh/`,
        refreshToken: refreshToken
      }
    });

    if (!response?.ok) {
      // Clear tokens and ask user to login
      await chrome.storage.local.remove(['accessToken', 'refreshToken']);
      throw new Error('Session expired. Please login again.');
    }

    return response.accessToken;
  }

  /**
   * Get valid access token
   */
  async function getValidAccessToken() {
    let { accessToken } = await chrome.storage.local.get('accessToken');
    
    if (!accessToken || isAccessTokenExpired(accessToken)) {
      accessToken = await refreshAccessToken();
    }
    
    return accessToken;
  }

  /**
   * Show toast notification with sync results
   */
  function showToast(created, skipped, failed, errors = [], syncedOrderIds = [], skippedOrderIds = []) {
    // Remove existing toast if any
    const existingToast = document.querySelector('.vh-toast-container');
    if (existingToast) existingToast.remove();

    // Determine toast type and message
    let type = 'success';
    let title = 'Sync Completed';
    let icon = '✅';
    
    if (failed > 0 || errors.length > 0) {
      type = 'warning';
      title = 'Sync Completed with Issues';
      icon = '⚠️';
    }
    if (created === 0 && skipped === 0 && failed > 0) {
      type = 'error';
      title = 'Sync Failed';
      icon = '❌';
    }

    // Build message
    const messages = [];
    if (created > 0) {
      messages.push(`<div class="vh-toast-line vh-toast-success">✅ ${created} new order(s) created</div>`);
      if (syncedOrderIds.length > 0) {
        const displayIds = syncedOrderIds.slice(0, 5).join(', ');
        const more = syncedOrderIds.length > 5 ? ` +${syncedOrderIds.length - 5} more` : '';
        messages.push(`<div class="vh-toast-order-ids"><small>📋 ${displayIds}${more}</small></div>`);
      }
    }
    if (skipped > 0) {
      messages.push(`<div class="vh-toast-line vh-toast-skip">⏭️ ${skipped} order(s) skipped (duplicate)</div>`);
      if (skippedOrderIds.length > 0) {
        const displayIds = skippedOrderIds.slice(0, 3).join(', ');
        const more = skippedOrderIds.length > 3 ? ` +${skippedOrderIds.length - 3} more` : '';
        messages.push(`<div class="vh-toast-order-ids vh-toast-skip-ids"><small>📋 ${displayIds}${more}</small></div>`);
      }
    }
    if (failed > 0) messages.push(`<div class="vh-toast-line vh-toast-error">❌ ${failed} order(s) failed</div>`);
    if (errors.length > 0) {
      const errorMsgs = errors.slice(0, 3).map(e => {
        if (typeof e === 'string') return e;
        if (e && typeof e === 'object') {
          return e.message || e.error || e.detail || e.order_id
            ? `${e.order_id ? e.order_id + ': ' : ''}${e.message || e.error || e.detail || ''}`
            : JSON.stringify(e);
        }
        return String(e);
      });
      messages.push(`<div class="vh-toast-errors"><small>${errorMsgs.join('<br>')}</small></div>`);
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `vh-toast-container vh-toast-${type}`;
    toast.innerHTML = `
      <div class="vh-toast">
        <div class="vh-toast-header">
          <span class="vh-toast-icon">${icon}</span>
          <span class="vh-toast-title">${title}</span>
          <button class="vh-toast-close">&times;</button>
        </div>
        <div class="vh-toast-body">
          ${messages.join('')}
        </div>
        <div class="vh-toast-progress">
          <div class="vh-toast-progress-bar"></div>
        </div>
      </div>
    `;

    // Add styles if not exist
    if (!document.querySelector('#vh-toast-styles')) {
      const style = document.createElement('style');
      style.id = 'vh-toast-styles';
      style.textContent = `
        .vh-toast-container {
          position: fixed;
          top: 20px;
          right: 20px;
          z-index: 999999;
          animation: vh-toast-slide-in 0.3s ease-out;
        }
        @keyframes vh-toast-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes vh-toast-slide-out {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }
        .vh-toast {
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          border-radius: 12px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.4);
          min-width: 320px;
          max-width: 400px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.1);
        }
        .vh-toast-success .vh-toast { border-left: 4px solid #00c853; }
        .vh-toast-warning .vh-toast { border-left: 4px solid #ff9800; }
        .vh-toast-error .vh-toast { border-left: 4px solid #ff5252; }
        .vh-toast-header {
          display: flex;
          align-items: center;
          padding: 12px 16px;
          background: rgba(255,255,255,0.05);
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .vh-toast-icon {
          font-size: 20px;
          margin-right: 10px;
        }
        .vh-toast-title {
          flex: 1;
          font-weight: 600;
          color: #fff;
          font-size: 14px;
        }
        .vh-toast-close {
          background: none;
          border: none;
          color: rgba(255,255,255,0.5);
          font-size: 20px;
          cursor: pointer;
          padding: 0;
          line-height: 1;
        }
        .vh-toast-close:hover { color: #fff; }
        .vh-toast-body {
          padding: 12px 16px;
        }
        .vh-toast-line {
          padding: 6px 0;
          font-size: 13px;
          color: #fff;
        }
        .vh-toast-success { color: #69f0ae; }
        .vh-toast-skip { color: #ffb74d; }
        .vh-toast-error { color: #ff8a80; }
        .vh-toast-order-ids {
          padding: 4px 8px;
          margin: 4px 0;
          background: rgba(105,240,174,0.1);
          border-radius: 4px;
          font-family: monospace;
          color: #69f0ae;
          word-break: break-all;
        }
        .vh-toast-skip-ids {
          background: rgba(255,183,77,0.1);
          color: #ffb74d;
        }
        .vh-toast-errors {
          margin-top: 8px;
          padding: 8px;
          background: rgba(255,82,82,0.1);
          border-radius: 6px;
          color: #ff8a80;
        }
        .vh-toast-login-btn {
          display: block;
          width: 100%;
          margin-top: 12px;
          padding: 10px 16px;
          background: linear-gradient(135deg, #ff416c 0%, #ff4b2b 100%);
          border: none;
          border-radius: 8px;
          color: #fff;
          font-weight: 600;
          cursor: pointer;
          text-align: center;
        }
        .vh-toast-login-btn:hover {
          opacity: 0.9;
        }
        .vh-toast-progress {
          height: 3px;
          background: rgba(255,255,255,0.1);
        }
        .vh-toast-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #ff416c, #ff4b2b);
          animation: vh-toast-countdown 5s linear forwards;
        }
        @keyframes vh-toast-countdown {
          from { width: 100%; }
          to { width: 0%; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(toast);

    // Close button handler
    toast.querySelector('.vh-toast-close').addEventListener('click', () => {
      toast.style.animation = 'vh-toast-slide-out 0.3s ease-in forwards';
      setTimeout(() => toast.remove(), 300);
    });

    // Auto-close after 5 seconds
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.animation = 'vh-toast-slide-out 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
      }
    }, 5000);
  }

  /**
   * Show login required toast
   */
  function showLoginRequiredToast() {
    // Remove existing toast if any
    const existingToast = document.querySelector('.vh-toast-container');
    if (existingToast) existingToast.remove();

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
          <div class="vh-toast-line vh-toast-skip">Please click the VH button in your browser toolbar to login.</div>
          <button class="vh-toast-login-btn" id="vh-open-popup-btn">
            🔑 Open Login
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(toast);

    // Close button handler
    toast.querySelector('.vh-toast-close').addEventListener('click', () => {
      toast.style.animation = 'vh-toast-slide-out 0.3s ease-in forwards';
      setTimeout(() => toast.remove(), 300);
    });

    // Open popup button - trigger extension popup
    toast.querySelector('#vh-open-popup-btn').addEventListener('click', () => {
      // Send message to open popup
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
      toast.style.animation = 'vh-toast-slide-out 0.3s ease-in forwards';
      setTimeout(() => toast.remove(), 300);
    });

    // Don't auto-close login toast - user needs to take action
  }

  /**
   * Show shop name required toast
   */
  function showShopNameRequiredToast() {
    // Remove existing toast if any
    const existingToast = document.querySelector('.vh-toast-container');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'vh-toast-container vh-toast-warning';
    toast.innerHTML = `
      <div class="vh-toast">
        <div class="vh-toast-header">
          <span class="vh-toast-icon">🏪</span>
          <span class="vh-toast-title">Shop Name Required</span>
          <button class="vh-toast-close">&times;</button>
        </div>
        <div class="vh-toast-body">
          <div class="vh-toast-line">Please set your Etsy shop name before syncing orders.</div>
          <div class="vh-toast-line vh-toast-skip">Click the VH extension icon in your browser toolbar to enter your shop name.</div>
          <div class="vh-toast-line" style="margin-top: 8px; font-size: 11px; color: #aaa;">
            📍 Find your shop name in URL: etsy.com/your/shops/<strong style="color: #ff9800;">YourShopName</strong>/orders
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(toast);

    // Close button handler
    toast.querySelector('.vh-toast-close').addEventListener('click', () => {
      toast.style.animation = 'vh-toast-slide-out 0.3s ease-in forwards';
      setTimeout(() => toast.remove(), 300);
    });

    // Don't auto-close - user needs to take action
  }

  /**
   * Show account not found toast (when server returns 404)
   */
  function showAccountNotFoundToast(shopName, errorMsg) {
    // Remove existing toast if any
    const existingToast = document.querySelector('.vh-toast-container');
    if (existingToast) existingToast.remove();

    // Try to extract available accounts from error message
    let availableAccounts = [];
    try {
      const match = errorMsg.match(/available_accounts.*?\[(.*?)\]/);
      if (match) {
        availableAccounts = match[1].split(',').map(s => s.replace(/['"]/g, '').trim());
      }
    } catch (e) {}

    // Check if this might be a session issue - available_accounts not empty but doesn't include our shop
    const mightBeSessionIssue = availableAccounts.length > 0 && 
      !availableAccounts.some(acc => acc.toLowerCase() === shopName.toLowerCase());

    const availableHtml = availableAccounts.length > 0 
      ? `<div class="vh-toast-line" style="margin-top: 8px; font-size: 11px;">
           Available accounts: <strong style="color: #69f0ae;">${availableAccounts.join(', ')}</strong>
         </div>`
      : '';

    const sessionWarningHtml = mightBeSessionIssue
      ? `<div class="vh-toast-line" style="margin-top: 8px; font-size: 11px; color: #ff9800;">
           ⚠️ This might be a session issue. Try logging out and logging in again.
         </div>
         <button class="vh-toast-login-btn vh-logout-btn" style="margin-top: 8px; background: #ff5252;">
           🔄 Logout & Login Again
         </button>`
      : '';

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
          <div class="vh-toast-line vh-toast-error">Account for shop "<strong>${shopName}</strong>" not found on VH server.</div>
          <div class="vh-toast-line vh-toast-skip">Please add this shop on VH website first, or update the shop name in extension settings.</div>
          ${availableHtml}
          ${sessionWarningHtml}
          <a href="https://vhmediaco.app/ecommerce/account" target="_blank" class="vh-toast-login-btn" style="margin-top: 12px;">
            ➕ Add Account on VH
          </a>
        </div>
      </div>
    `;

    document.body.appendChild(toast);

    // Logout button handler
    const logoutBtn = toast.querySelector('.vh-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        // Clear all tokens and stored data
        await chrome.storage.local.remove(['accessToken', 'refreshToken', 'userName', 'userEmail']);
        toast.style.animation = 'vh-toast-slide-out 0.3s ease-in forwards';
        setTimeout(() => {
          toast.remove();
          // Show login required toast
          showLoginRequiredToast();
        }, 300);
      });
    }

    // Close button handler
    toast.querySelector('.vh-toast-close').addEventListener('click', () => {
      toast.style.animation = 'vh-toast-slide-out 0.3s ease-in forwards';
      setTimeout(() => toast.remove(), 300);
    });

    // Don't auto-close - user needs to take action
  }

  /**
   * Send orders to API via service worker ONLY (localhost không fetch được từ content script)
   * @param {boolean} isRetryAfterRefresh - internal flag to prevent infinite retry
   */
  async function syncOrdersToAPI(orders, tokenOverride, isRetryAfterRefresh = false, shopNameOverride = '') {
    const stored = await chrome.storage.local.get('accessToken');
    const accessToken = tokenOverride || stored.accessToken;
    const url = `${API_URL}/api/ecommerce/etsy/sync-orders/`;
    const payloadShopName = (shopNameOverride || orders?.[0]?.shop_name || '').trim();
    const payloadShopAscii = payloadShopName
      ? payloadShopName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
      : '';
    const payload = payloadShopName
      ? {
          orders,
          shop_name: payloadShopName,
          shopName: payloadShopName,
          etsy_shop_name: payloadShopName,
          account_name: payloadShopName,
          accountName: payloadShopName,
          store_name: payloadShopName,
          shop_name_ascii: payloadShopAscii
        }
      : { orders };

    // Check if localhost - try direct fetch first
    const isLocalhost = API_URL.includes('localhost') || API_URL.includes('127.0.0.1');
    
    if (isLocalhost) {
      try {
        const directResp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
          },
          body: JSON.stringify(payload)
        });
        
        const text = await directResp.text();
        
        if (!directResp.ok) {
          if (directResp.status === 401) {
            const newAccessToken = await refreshAccessToken();
            return await syncOrdersToAPI(orders, newAccessToken, true, payloadShopName);
          }
          // Check for 404 with "not found" - might be stale token issue
          if (directResp.status === 404 && text.includes('not found') && text.includes('available_accounts') && !isRetryAfterRefresh) {
            console.log('[Sync] Got 404 with available_accounts, trying token refresh...');
            try {
              const newAccessToken = await refreshAccessToken();
              return await syncOrdersToAPI(orders, newAccessToken, true, payloadShopName);
            } catch (refreshErr) {
              console.log('[Sync] Token refresh failed, showing original error');
            }
          }
          throw new Error(`API error ${directResp.status}: ${text}`);
        }
        
        let responseData = text;
        try {
          responseData = JSON.parse(text);
        } catch (e) {
          responseData = { success: true, created: orders.length, skipped: 0, errors: [] };
        }
        return responseData;
      } catch (err) {
        console.error('[Sync] Direct fetch failed:', err.message);
        throw err;
      }
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'ETSY_API_POST',
        payload: { url, data: payload, token: accessToken }
      });

      if (!resp) throw new Error('No response from service worker');
      if (!resp.ok) {
        if (resp.status === 401) {
          const newAccessToken = await refreshAccessToken();
          return await syncOrdersToAPI(orders, newAccessToken, true, payloadShopName);
        }
        // Check for 404 with "not found" - might be stale token issue
        if (resp.status === 404 && resp.body && resp.body.includes('not found') && resp.body.includes('available_accounts') && !isRetryAfterRefresh) {
          console.log('[Sync] Got 404 with available_accounts via SW, trying token refresh...');
          try {
            const newAccessToken = await refreshAccessToken();
            return await syncOrdersToAPI(orders, newAccessToken, true, payloadShopName);
          } catch (refreshErr) {
            console.log('[Sync] Token refresh failed, showing original error');
          }
        }
        throw new Error(`API error ${resp.status}: ${resp.body}`);
      }
      
      // Parse response body (SW returns text, need to parse JSON)
      let responseData = resp.body;
      if (typeof responseData === 'string') {
        try {
          responseData = JSON.parse(responseData);
        } catch (e) {
          responseData = { success: true, created: orders.length, skipped: 0, errors: [] };
        }
      }
      return responseData || { success: true, created: orders.length, skipped: 0, errors: [] };
    } catch (err) {
      console.error('[Sync] Error:', err.message);
      throw err;
    }
  }

  /**
   * Create and inject the sync button
   */
  function createSyncButton() {
    // Check if button already exists
    if (document.querySelector('.vh-etsy-sync-container')) return;

    // Create container
    const container = document.createElement('div');
    container.className = 'vh-etsy-sync-container';
    container.innerHTML = `
      <div class="vh-sync-panel">
        <div class="vh-sync-header">
          <span class="vh-sync-logo">VH</span>
          <span class="vh-sync-title">Etsy Order Sync</span>
          <button class="vh-sync-minimize" title="Minimize">−</button>
        </div>
        <div class="vh-sync-body">
          <div class="vh-sync-status">
            <span class="vh-status-dot"></span>
            <span class="vh-status-text">Ready to sync</span>
          </div>
          <div class="vh-sync-actions">
            <button class="vh-btn vh-btn-primary vh-sync-selected" title="Sync selected orders">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                <path d="M9 12l2 2 4-4"/>
              </svg>
              Sync Selected
            </button>
            <button class="vh-btn vh-btn-secondary vh-sync-all" title="Sync all visible orders">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"/>
                <path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/>
                <path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/>
              </svg>
              Sync All
            </button>
          </div>
          <div class="vh-sync-progress" style="display: none;">
            <div class="vh-progress-bar">
              <div class="vh-progress-fill"></div>
            </div>
            <span class="vh-progress-text">0 / 0</span>
          </div>
          <div class="vh-sync-results" style="display: none;">
            <div class="vh-result-success">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
                <path d="M22 4L12 14.01l-3-3"/>
              </svg>
              <span class="vh-success-count">0</span> new
            </div>
            <div class="vh-result-skipped">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 3l14 9-14 9V3z"/>
              </svg>
              <span class="vh-skipped-count">0</span> dup
            </div>
            <div class="vh-result-failed">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
              <span class="vh-failed-count">0</span> failed
            </div>
          </div>
        </div>
        <div class="vh-sync-footer">
          <span class="vh-user-info"></span>
          <button class="vh-btn-link vh-settings-btn" title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    // Initialize event handlers
    initializeEventHandlers(container);
    
    // Check auth status
    checkAuthStatus();
  }

  /**
   * Initialize event handlers
   */
  function initializeEventHandlers(container) {
    // Minimize button
    const minimizeBtn = container.querySelector('.vh-sync-minimize');
    const panel = container.querySelector('.vh-sync-panel');
    let isMinimized = false;

    minimizeBtn.addEventListener('click', () => {
      isMinimized = !isMinimized;
      panel.classList.toggle('vh-minimized', isMinimized);
      minimizeBtn.textContent = isMinimized ? '+' : '−';
    });

    // Sync Selected button
    const syncSelectedBtn = container.querySelector('.vh-sync-selected');
    syncSelectedBtn.addEventListener('click', () => syncOrders('selected'));

    // Sync All button
    const syncAllBtn = container.querySelector('.vh-sync-all');
    syncAllBtn.addEventListener('click', () => syncOrders('all'));

    // Settings button
    const settingsBtn = container.querySelector('.vh-settings-btn');
    settingsBtn.addEventListener('click', () => {
      // Open extension popup or settings page
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
    });
  }

  /**
   * Check authentication status
   */
  async function checkAuthStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ETSY_CHECK_AUTH' });
      updateAuthUI(response?.data?.isAuthenticated, response?.data?.username);
    } catch (e) {
      console.error('Auth check failed:', e);
      updateAuthUI(false);
    }
  }

  /**
   * Update UI based on auth status
   */
  function updateAuthUI(isAuthenticated, username) {
    const userInfo = document.querySelector('.vh-user-info');
    const syncButtons = document.querySelectorAll('.vh-sync-actions button');

    if (isAuthenticated) {
      userInfo.textContent = `👤 ${username || 'User'}`;
      userInfo.classList.add('vh-authenticated');
      syncButtons.forEach(btn => btn.disabled = false);
    } else {
      userInfo.innerHTML = '<a href="#" class="vh-login-link">Login required</a>';
      userInfo.classList.remove('vh-authenticated');
      syncButtons.forEach(btn => btn.disabled = true);
    }
  }

  /**
   * Get selected orders from the page
   */
  function getSelectedOrders() {
    // Etsy checkboxes: input[type="checkbox"][name] inside .panel-body-row
    // The name attribute is the order ID number (e.g. "4003961994")
    const selectedCheckboxes = document.querySelectorAll('.panel-body-row input[type="checkbox"]:checked');
    const orderIds = [];

    selectedCheckboxes.forEach(checkbox => {
      const orderId = checkbox.name || 
                     checkbox.getAttribute('data-order-id') || 
                     checkbox.closest('[data-order-id]')?.getAttribute('data-order-id') ||
                     checkbox.value;
      if (orderId) orderIds.push(orderId);
    });

    return orderIds;
  }

  /**
   * Sync orders to database
   */
  async function syncOrders(mode) {
    const statusText = document.querySelector('.vh-status-text');
    const statusDot = document.querySelector('.vh-status-dot');
    const progressEl = document.querySelector('.vh-sync-progress');
    const progressFill = document.querySelector('.vh-progress-fill');
    const progressText = document.querySelector('.vh-progress-text');
    const resultsEl = document.querySelector('.vh-sync-results');
    const successCount = document.querySelector('.vh-success-count');
    const failedCount = document.querySelector('.vh-failed-count');
    const syncButtons = document.querySelectorAll('.vh-sync-actions button');

    // Disable buttons during sync
    syncButtons.forEach(btn => btn.disabled = true);

    try {
      // Check if shop name is set
      const { etsyShopName } = await chrome.storage.local.get('etsyShopName');
      const normalizedShopName = (etsyShopName || '').trim();
      if (!normalizedShopName) {
        showShopNameRequiredToast();
        throw new Error('Shop name not set. Please click the VH extension icon and enter your Etsy shop name.');
      }
      
      // Update status
      statusText.textContent = 'Scraping orders...';
      statusDot.className = 'vh-status-dot vh-status-syncing';

      // Initialize scraper
      const scraper = new window.VHEtsyOrderScraper();
      let orders = await scraper.scrape();
      
      // === DEBUG: Log all SKUs for each order ===
      console.log('[VH Sync] ========== DEBUG: Orders & SKUs ==========');
      orders.forEach((order, orderIdx) => {
        const skus = (order.items || []).map(item => item.sku || 'NO_SKU');
        console.log(`[VH Sync] Order ${orderIdx + 1}: ${order.order_id}`);
        console.log(`[VH Sync]   Items (${order.items?.length || 0}):`, skus);
        
        // Check for duplicate SKUs within this order
        const skuCounts = {};
        skus.forEach(s => { skuCounts[s] = (skuCounts[s] || 0) + 1; });
        const duplicates = Object.entries(skuCounts).filter(([k, v]) => v > 1);
        if (duplicates.length > 0) {
          console.warn(`[VH Sync]   ⚠️ DUPLICATE SKUs in order ${order.order_id}:`, duplicates);
        }
        
        // Log each item details
        (order.items || []).forEach((item, itemIdx) => {
          console.log(`[VH Sync]   Item ${itemIdx + 1}: SKU="${item.sku}", Name="${item.name?.substring(0, 50)}...", Qty=${item.quantity}`);
          console.log(`[VH Sync]   Item ${itemIdx + 1} variations:`, JSON.stringify(item.variations));
          console.log(`[VH Sync]   Item ${itemIdx + 1} parsed_variants:`, JSON.stringify(item.parsed_variants));
        });
      });
      
      // Check for duplicate SKUs across all orders
      const allSkus = orders.flatMap(o => (o.items || []).map(i => i.sku));
      const globalSkuCounts = {};
      allSkus.forEach(s => { globalSkuCounts[s] = (globalSkuCounts[s] || 0) + 1; });
      const globalDuplicates = Object.entries(globalSkuCounts).filter(([k, v]) => v > 1);
      if (globalDuplicates.length > 0) {
        console.warn('[VH Sync] ⚠️ DUPLICATE SKUs across ALL orders:', globalDuplicates);
      }
      console.log('[VH Sync] ===========================================');
      
      // Override shop_name with value from storage (để match với account trên server)
      orders = orders.map(order => ({
        ...order,
        shop_name: normalizedShopName,
        shopName: normalizedShopName,
        etsy_shop_name: normalizedShopName,
        account_name: normalizedShopName,
        accountName: normalizedShopName
      }));

      // Filter to selected if needed
      if (mode === 'selected') {
        const selectedIds = getSelectedOrders();
        if (selectedIds.length === 0) {
          // If no checkboxes selected, try to get current order from detail page
          if (!orders.length) {
            throw new Error('No orders selected. Please select orders to sync.');
          }
        } else {
          orders = orders.filter(o => {
            const orderId = o.order_id?.replace('ETSY-', '');
            return selectedIds.includes(orderId);
          });
        }
      }

      if (!orders.length) {
        throw new Error('No orders found to sync.');
      }

      // Show progress
      progressEl.style.display = 'flex';
      resultsEl.style.display = 'none';
      progressFill.style.width = '0%';
      progressText.textContent = `0 / ${orders.length}`;

      statusText.textContent = `Syncing ${orders.length} order(s) to "${normalizedShopName}"...`;

      // Send orders to API
      let totalCreated = 0;
      let totalSkipped = 0;
      let totalFailed = 0;
      let batchErrors = [];
      let syncedOrderIds = [];
      let skippedOrderIds = [];

      // Batch orders for better performance
      const batchSize = 10;
      const batches = [];
      for (let i = 0; i < orders.length; i += batchSize) {
        batches.push(orders.slice(i, i + batchSize));
      }

      let processedBatches = 0;
      for (const batch of batches) {
        try {
          // Gọi API trực tiếp qua service worker (giống AliExpress)
          const result = await syncOrdersToAPI(batch);
          totalCreated += result.created || 0;
          totalSkipped += result.skipped || 0;
          if (result.created_order_ids) {
            syncedOrderIds = syncedOrderIds.concat(result.created_order_ids);
          }
          if (result.skipped_order_ids) {
            skippedOrderIds = skippedOrderIds.concat(result.skipped_order_ids);
          }
          if (result.errors && result.errors.length > 0) {
            batchErrors = batchErrors.concat(result.errors);
          }
        } catch (e) {
          // Check if login required
          if (e.message.includes('login') || e.message.includes('refresh token') || e.message.includes('Session expired')) {
            showLoginRequiredToast();
            throw e;
          }
          // Check if account not found (404)
          if (e.message.includes('404') || e.message.includes('not found')) {
            showAccountNotFoundToast(normalizedShopName, e.message);
            throw e;
          }
          totalFailed += batch.length;
          console.error('❌ Batch sync error:', e.message);
        }

        processedBatches++;
        // Update progress
        const progress = (processedBatches / batches.length) * 100;
        progressFill.style.width = `${progress}%`;
        progressText.textContent = `${processedBatches} / ${batches.length} batches`;
      }

      // Show results
      progressEl.style.display = 'none';
      resultsEl.style.display = 'flex';
      successCount.textContent = totalCreated;
      document.querySelector('.vh-skipped-count').textContent = totalSkipped;
      failedCount.textContent = totalFailed;

      // Show toastr notification with order IDs
      showToast(totalCreated, totalSkipped, totalFailed, batchErrors, syncedOrderIds, skippedOrderIds);

      if (totalFailed === 0 && batchErrors.length === 0) {
        statusText.textContent = 'Sync completed successfully!';
        statusDot.className = 'vh-status-dot vh-status-success';
      } else if (totalCreated === 0 && totalSkipped === 0) {
        statusText.textContent = 'Sync failed!';
        statusDot.className = 'vh-status-dot vh-status-error';
      } else {
        statusText.textContent = 'Sync completed with some issues';
        statusDot.className = 'vh-status-dot vh-status-warning';
      }

    } catch (e) {
      console.error('Sync error:', e);
      statusText.textContent = e.message || 'Sync failed!';
      statusDot.className = 'vh-status-dot vh-status-error';
      progressEl.style.display = 'none';
      resultsEl.style.display = 'none';
    } finally {
      // Re-enable buttons after 2 seconds
      setTimeout(() => {
        syncButtons.forEach(btn => btn.disabled = false);
        checkAuthStatus();
      }, 2000);
    }
  }

  /**
   * Wait for page to be ready then inject button
   */
  function init() {
    // Wait for page content to load
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createSyncButton);
    } else {
      createSyncButton();
    }

    // Also handle SPA navigation
    const observer = new MutationObserver((mutations) => {
      if (!document.querySelector('.vh-etsy-sync-container')) {
        createSyncButton();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Initialize
  init();
})();
