/**
 * VH Whatnot Fetch Interceptor
 * Runs in MAIN world (page context) - bypasses CSP restrictions.
 * Patches window.fetch and XHR to capture GraphQL responses,
 * then dispatches CustomEvents to the ISOLATED world (whatnotOrderScraper.js).
 */
(function () {
  if (window.__VH_WN_INTERCEPT__) return;
  window.__VH_WN_INTERCEPT__ = true;

  function relay(url, data) {
    try {
      window.dispatchEvent(new CustomEvent('__vh_wn_gql', { detail: { url: url, data: data } }));
    } catch (e) {}
  }

  // Store last GQL URL + headers so we can fire custom queries
  var _lastGqlUrl = '';
  var _lastGqlHeaders = { 'Content-Type': 'application/json' };

  // ── Patch window.fetch ──
  var _origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    var promise = _origFetch.apply(this, arguments);
    if (url && url.indexOf('graphql') !== -1) {
      // Capture URL and headers from real Whatnot requests
      if (url) _lastGqlUrl = url;
      try {
        var h = (init && init.headers) || {};
        var captured = { 'Content-Type': 'application/json' };
        if (h instanceof Headers) {
          h.forEach(function (v, k) { captured[k] = v; });
        } else if (h && typeof h === 'object') {
          Object.keys(h).forEach(function (k) { captured[k] = h[k]; });
        }
        // Keep Authorization, x-whatnot-* etc
        _lastGqlHeaders = captured;
      } catch (e) {}

      promise.then(function (resp) {
        try {
          resp.clone().json().then(function (d) {
            if (d && d.data) relay(url, d);
          }).catch(function () {});
        } catch (e) {}
      }).catch(function () {});
    }
    return promise;
  };

  // ── Listen for custom GQL query requests from isolated world ──
  // Fires the query using captured Whatnot headers so auth works
  window.addEventListener('__vh_wn_gql_query__', function (e) {
    if (!e.detail || !_lastGqlUrl) return;
    var body = e.detail.body;
    var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    _origFetch(_lastGqlUrl, {
      method: 'POST',
      headers: _lastGqlHeaders,
      body: bodyStr,
      credentials: 'include',
    }).then(function (resp) {
      return resp.clone().json();
    }).then(function (d) {
      if (d && d.data) relay(_lastGqlUrl, d);
    }).catch(function () {});
  });

  // ── Patch XMLHttpRequest ──
  var _origOpen = XMLHttpRequest.prototype.open;
  var _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._vhWNUrl = url || '';
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (xhr._vhWNUrl && xhr._vhWNUrl.indexOf('graphql') !== -1) {
      xhr.addEventListener('load', function () {
        try {
          var d = JSON.parse(xhr.responseText);
          if (d && d.data) relay(xhr._vhWNUrl, d);
        } catch (e) {}
      });
    }
    return _origSend.apply(this, arguments);
  };
})();
