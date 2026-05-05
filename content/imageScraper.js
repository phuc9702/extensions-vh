/**
 * VH Extension - Image Scraper for Etsy & Amazon
 * Scrapes product images + titles and uploads to Google Drive
 * Target folder: 1vaLpXzV0K2C7-ltNG0GVeeH6MAmylUvL
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__VH_IMAGE_SCRAPER__) return;
  window.__VH_IMAGE_SCRAPER__ = true;

  const DRIVE_FOLDER_ID = '11zQeBNHuzRycQomISbAK1WFFceMjX-YZ'; // Shared Drive folder

  // ─── Utility ───
  const Utils = {
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    safeText: (el) => el?.textContent?.trim() || '',
    sanitizeFileName: (name) => {
      return name
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 200);
    },
  };

  function normalizeEtsyImageUrl(url) {
    if (!url) return '';
    let normalized = url;
    if (normalized.includes('data:image')) return '';
    normalized = normalized.replace(/il_\d+x\d+/g, 'il_600x600');
    normalized = normalized.replace(/il_\d+xN/g, 'il_600x600');
    normalized = normalized.replace(/\/\d+x\d+\//g, '/600x600/');
    return normalized;
  }

  // ─── Detect platform ───
  function detectPlatform() {
    const host = window.location.hostname;
    if (host.includes('etsy.com')) return 'etsy';
    if (host.includes('amazon.')) return 'amazon';
    return null;
  }

  // ─── Scrape Etsy product ───
  function scrapeEtsy() {
    const images = [];
    let title = '';

    // Title
    const titleEl =
      document.querySelector('h1[data-buy-box-listing-title]') ||
      document.querySelector('h1.wt-text-body-03') ||
      document.querySelector('#listing-page-cart h1') ||
      document.querySelector('h1');
    title = Utils.safeText(titleEl);

    // Main images (carousel / gallery)
    const imgSelectors = [
      'ul.carousel-pane-list img',
      '[data-component="listing-page-image-carousel"] img',
      '.image-carousel-container img',
      '.listing-page-image-carousel-component img',
      'img.carousel-image',
      '#photos img',
    ];

    for (const sel of imgSelectors) {
      document.querySelectorAll(sel).forEach((img) => {
        let src = img.src || img.dataset.src || img.dataset.srcDelay || '';
        if (src && !src.includes('data:image')) {
          // Get highest resolution version
          src = src.replace(/il_\d+x\d+/, 'il_fullxfull');
          src = src.replace(/il_\d+xN/, 'il_fullxfull');
          if (!images.includes(src)) images.push(src);
        }
      });
      if (images.length > 0) break;
    }

    // Fallback: meta og:image
    if (images.length === 0) {
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg?.content) images.push(ogImg.content);
    }

    return { title, images, platform: 'Etsy' };
  }

  // ─── Scrape Etsy search/listing page ───
  function scrapeEtsySearchPage() {
    const items = [];
    const seen = new Set();

    const cards = Array.from(
      document.querySelectorAll('[data-listing-id], .v2-listing-card, .listing-card')
    );

    cards.forEach((card) => {
      const linkEl = card.querySelector('a[href*="/listing/"]');
      if (!linkEl) return;

      const titleEl = card.querySelector('h3');
      const imgEl = card.querySelector('img');

      const title =
        Utils.safeText(titleEl) ||
        imgEl?.getAttribute('alt') ||
        Utils.safeText(linkEl) ||
        '';

      let imageUrl = '';
      const srcset = imgEl?.getAttribute('srcset');
      if (srcset) {
        const parts = srcset
          .split(',')
          .map((s) => s.trim().split(' ')[0])
          .filter(Boolean);
        imageUrl = parts[parts.length - 1] || '';
      }

      if (!imageUrl) {
        imageUrl = imgEl?.src || imgEl?.dataset?.src || imgEl?.dataset?.srcDelay || '';
      }

      imageUrl = normalizeEtsyImageUrl(imageUrl);
      if (!title || !imageUrl) return;

      const key = `${title}__${imageUrl}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({ title, imageUrl });
    });

    return { items, platform: 'Etsy', pageTitle: document.title || 'Etsy Search' };
  }

  // ─── Scrape Amazon product ───
  function scrapeAmazon() {
    const images = [];
    let title = '';

    // Title
    const titleEl =
      document.getElementById('productTitle') ||
      document.querySelector('#title span') ||
      document.querySelector('h1.a-size-large') ||
      document.querySelector('h1');
    title = Utils.safeText(titleEl);

    // Amazon image data from JS variable
    try {
      const scripts = document.querySelectorAll('script[type="text/javascript"]');
      for (const script of scripts) {
        const text = script.textContent;
        if (text.includes("'colorImages'") || text.includes('"colorImages"')) {
          const match = text.match(
            /(?:'colorImages'|"colorImages")\s*:\s*\{\s*(?:'initial'|"initial")\s*:\s*(\[[\s\S]*?\])\s*\}/
          );
          if (match) {
            const imgData = JSON.parse(match[1].replace(/'/g, '"'));
            imgData.forEach((item) => {
              const hiRes = item.hiRes || item.large || item.main?.url;
              if (hiRes && !images.includes(hiRes)) images.push(hiRes);
            });
          }
        }
      }
    } catch (e) {
      console.warn('[VH] Failed to parse Amazon image JSON:', e);
    }

    // Fallback: image elements
    if (images.length === 0) {
      const imgSelectors = [
        '#imgTagWrapperId img',
        '#imageBlock img',
        '#altImages img',
        '#main-image-container img',
        '.a-dynamic-image',
      ];

      for (const sel of imgSelectors) {
        document.querySelectorAll(sel).forEach((img) => {
          let src = img.src || img.dataset.oldHires || '';
          if (src && !src.includes('data:image') && !src.includes('sprite')) {
            // Get high-res
            src = src.replace(/\._[A-Z]+\d+_\./, '.');
            src = src.replace(/\._S[XY]\d+_\./, '.');
            if (!images.includes(src)) images.push(src);
          }
        });
      }
    }

    // Final fallback: og:image
    if (images.length === 0) {
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg?.content) images.push(ogImg.content);
    }

    return { title, images, platform: 'Amazon' };
  }

  // ─── Show toast notification ───
  function showToast(message, type = 'info') {
    const existing = document.getElementById('vh-scraper-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'vh-scraper-toast';
    const bgColor =
      type === 'success'
        ? '#28a745'
        : type === 'error'
        ? '#dc3545'
        : type === 'warning'
        ? '#ffc107'
        : '#007bff';

    toast.style.cssText = `
      position: fixed; bottom: 120px; right: 20px; z-index: 100000;
      background: ${bgColor}; color: white; padding: 12px 20px;
      border-radius: 8px; font-size: 14px; font-family: -apple-system, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2); max-width: 350px;
      animation: vhToastIn 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'vhToastOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ─── Show image selection modal ───
  function showImageModal(data) {
    // Remove existing modal
    const existing = document.getElementById('vh-image-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'vh-image-modal';
    modal.innerHTML = `
      <div class="vh-modal-overlay">
        <div class="vh-modal-content">
          <div class="vh-modal-header">
            <h3>📸 VH Image Scraper - ${data.platform}</h3>
            <button class="vh-modal-close">&times;</button>
          </div>
          <div class="vh-modal-body">
            <div class="vh-modal-title-section">
              <label>Product Title (used as file name):</label>
              <input type="text" class="vh-title-input" value="${data.title.replace(/"/g, '&quot;')}" />
            </div>
            <div class="vh-modal-info">
              <span>Found <strong>${data.images.length}</strong> image(s)</span>
              <label class="vh-select-all-label">
                <input type="checkbox" class="vh-select-all" checked /> Select All
              </label>
            </div>
            <div class="vh-image-grid">
              ${data.images
                .map(
                  (url, i) => `
                <div class="vh-image-item">
                  <label>
                    <input type="checkbox" class="vh-img-checkbox" data-index="${i}" data-url="${url}" checked />
                    <img src="${url}" alt="Image ${i + 1}" loading="lazy" />
                    <span class="vh-img-index">${i + 1}</span>
                  </label>
                </div>
              `
                )
                .join('')}
            </div>
          </div>
          <div class="vh-modal-footer">
            <button class="vh-btn vh-btn-cancel">Cancel</button>
            <button class="vh-btn vh-btn-upload">
              <span class="vh-btn-text">⬆️ Upload to Google Drive</span>
              <span class="vh-btn-loader" style="display:none;">Uploading...</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event: Close
    modal.querySelector('.vh-modal-close').onclick = () => modal.remove();
    modal.querySelector('.vh-btn-cancel').onclick = () => modal.remove();
    modal.querySelector('.vh-modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) modal.remove();
    });

    // Event: Select All
    const selectAllCb = modal.querySelector('.vh-select-all');
    selectAllCb.addEventListener('change', () => {
      modal.querySelectorAll('.vh-img-checkbox').forEach((cb) => {
        cb.checked = selectAllCb.checked;
      });
    });

    // Event: Upload
    modal.querySelector('.vh-btn-upload').addEventListener('click', async () => {
      const titleInput = modal.querySelector('.vh-title-input');
      const productTitle = titleInput.value.trim() || 'Untitled';
      const selectedUrls = [];

      modal.querySelectorAll('.vh-img-checkbox:checked').forEach((cb) => {
        selectedUrls.push(cb.dataset.url);
      });

      if (selectedUrls.length === 0) {
        showToast('Please select at least one image!', 'warning');
        return;
      }

      const uploadBtn = modal.querySelector('.vh-btn-upload');
      const btnText = uploadBtn.querySelector('.vh-btn-text');
      const btnLoader = uploadBtn.querySelector('.vh-btn-loader');

      uploadBtn.disabled = true;
      btnText.style.display = 'none';
      btnLoader.style.display = 'inline';
      btnLoader.textContent = `Downloading 0/${selectedUrls.length}...`;

      try {
        // Download images in content script (has access to page CDN)
        const imageDataList = [];
        for (let i = 0; i < selectedUrls.length; i++) {
          btnLoader.textContent = `Downloading ${i + 1}/${selectedUrls.length}...`;
          try {
            const imgData = await downloadImageAsBase64(selectedUrls[i]);
            imageDataList.push(imgData);
          } catch (dlErr) {
            console.warn(`[VH] Failed to download image ${i + 1}:`, dlErr);
            imageDataList.push(null);
          }
        }

        const validImages = imageDataList.filter(Boolean);
        if (validImages.length === 0) {
          showToast('❌ Failed to download any images!', 'error');
          return;
        }

        btnLoader.textContent = `Uploading ${validImages.length} image(s)...`;

        if (!chrome?.runtime?.sendMessage) {
          showToast('❌ Extension disconnected. Please refresh the page (F5).', 'error');
          return;
        }
        const response = await chrome.runtime.sendMessage({
          type: 'UPLOAD_IMAGES_TO_DRIVE',
          payload: {
            images: validImages,
            title: productTitle,
            folderId: DRIVE_FOLDER_ID,
            platform: data.platform,
          },
        });

        if (response?.ok) {
          showToast(
            `✅ ${response.uploaded}/${validImages.length} image(s) uploaded to Google Drive!`,
            'success'
          );
          setTimeout(() => modal.remove(), 1500);
        } else {
          const errMsg = response?.error || 'Upload failed';
          if (errMsg.includes('not authenticated') || errMsg.includes('OAuth')) {
            showToast('❌ Please connect Google Drive first (click extension icon > Settings)', 'error');
          } else {
            showToast(`❌ ${errMsg}`, 'error');
          }
        }
      } catch (err) {
        console.error('[VH] Upload error:', err);
        showToast(`❌ Error: ${err.message}`, 'error');
      } finally {
        uploadBtn.disabled = false;
        btnText.style.display = 'inline';
        btnLoader.style.display = 'none';
      }
    });
  }

  // ─── Download image as base64 via background script (CORS bypass) ───
  async function downloadImageAsBase64(url) {
    // First try via background script (no CORS issues)
    if (chrome?.runtime?.sendMessage) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_IMAGE_AS_BASE64',
          payload: { url },
        });
        if (response?.ok) {
          return { base64: response.base64, mimeType: response.mimeType, url };
        }
        console.warn('[VH] Background download failed:', response?.error);
      } catch (bgErr) {
        console.warn('[VH] Background download error:', bgErr.message);
      }
    }

    // Fallback: try fetch in content script (may fail due to CORS)
    try {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const mimeType = blob.type || 'image/jpeg';

      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          resolve({ base64, mimeType, url });
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      // Fallback: use canvas to convert img element
      console.warn('[VH] Fetch failed, trying canvas fallback:', e.message);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
            const base64 = dataUrl.split(',')[1];
            resolve({ base64, mimeType: 'image/jpeg', url });
          } catch (canvasErr) {
            reject(canvasErr);
          }
        };
        img.onerror = () => reject(new Error('Image load failed'));
        img.src = url;
      });
    }
  }

  // ─── Inject CSS ───
  function injectStyles() {
    if (document.getElementById('vh-scraper-styles')) return;

    const style = document.createElement('style');
    style.id = 'vh-scraper-styles';
    style.textContent = `
      @keyframes vhToastIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes vhToastOut { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(20px); } }
      @keyframes vhSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

      .vh-scrape-btn-container {
        position: fixed;
        bottom: 110px;
        right: 20px;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .vh-scrape-btn {
        background: linear-gradient(135deg, #4285f4, #34a853);
        color: white;
        border: none;
        padding: 10px 16px;
        font-size: 14px;
        font-weight: 600;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        box-shadow: 0 4px 12px rgba(66, 133, 244, 0.4);
        transition: all 0.2s ease;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      .vh-scrape-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 20px rgba(66, 133, 244, 0.5);
      }

      .vh-scrape-btn:active {
        transform: translateY(0);
      }

      /* Modal */
      .vh-modal-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        animation: vhToastIn 0.2s ease;
      }

      .vh-modal-content {
        background: white;
        border-radius: 12px;
        width: 90%;
        max-width: 700px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 24px 60px rgba(0,0,0,0.3);
      }

      .vh-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        border-bottom: 1px solid #eee;
      }

      .vh-modal-header h3 {
        margin: 0;
        font-size: 18px;
        color: #333;
      }

      .vh-modal-close {
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        color: #999;
        padding: 0 4px;
      }

      .vh-modal-close:hover { color: #333; }

      .vh-modal-body {
        padding: 16px 20px;
        overflow-y: auto;
        flex: 1;
      }

      .vh-modal-title-section {
        margin-bottom: 12px;
      }

      .vh-modal-title-section label {
        display: block;
        font-weight: 600;
        margin-bottom: 6px;
        color: #555;
        font-size: 13px;
      }

      .vh-title-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid #ddd;
        border-radius: 6px;
        font-size: 14px;
        outline: none;
        transition: border-color 0.2s;
      }

      .vh-title-input:focus {
        border-color: #4285f4;
        box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.1);
      }

      .vh-modal-info {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        font-size: 13px;
        color: #666;
      }

      .vh-select-all-label {
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        font-size: 13px;
      }

      .vh-image-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 10px;
      }

      .vh-image-item {
        position: relative;
        border-radius: 8px;
        overflow: hidden;
        border: 2px solid transparent;
        transition: border-color 0.2s;
      }

      .vh-image-item:has(input:checked) {
        border-color: #4285f4;
      }

      .vh-image-item label {
        display: block;
        cursor: pointer;
        position: relative;
      }

      .vh-image-item img {
        width: 100%;
        height: 140px;
        object-fit: cover;
        display: block;
      }

      .vh-image-item input[type="checkbox"] {
        position: absolute;
        top: 6px;
        left: 6px;
        z-index: 2;
        width: 18px;
        height: 18px;
        cursor: pointer;
      }

      .vh-img-index {
        position: absolute;
        bottom: 4px;
        right: 6px;
        background: rgba(0,0,0,0.6);
        color: white;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
      }

      .vh-modal-footer {
        padding: 12px 20px;
        border-top: 1px solid #eee;
        display: flex;
        justify-content: flex-end;
        gap: 10px;
      }

      .vh-btn {
        padding: 8px 20px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        transition: all 0.2s;
      }

      .vh-btn-cancel {
        background: #f1f3f5;
        color: #555;
      }

      .vh-btn-cancel:hover {
        background: #e9ecef;
      }

      .vh-btn-upload {
        background: linear-gradient(135deg, #4285f4, #34a853);
        color: white;
      }

      .vh-btn-upload:hover {
        box-shadow: 0 4px 12px rgba(66, 133, 244, 0.4);
      }

      .vh-btn-upload:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Add floating button ───
  function addScrapeButton() {
    if (document.querySelector('.vh-scrape-btn-container')) return;

    const container = document.createElement('div');
    container.className = 'vh-scrape-btn-container';
    container.innerHTML = `
      <button class="vh-scrape-btn" title="Scrape images and save to Google Drive">
        📸 Save Images to Drive
      </button>
      <button class="vh-scrape-btn vh-scrape-btn-page" title="Scrape all product images on this page">
        📄 Save Page Images
      </button>
    `;

    document.body.appendChild(container);

    container.querySelector('.vh-scrape-btn').addEventListener('click', async () => {
      const platform = detectPlatform();
      if (!platform) {
        showToast('Unsupported platform', 'error');
        return;
      }

      showToast(`Scanning ${platform} product...`, 'info');
      await Utils.wait(500);

      let data;
      if (platform === 'etsy') {
        data = scrapeEtsy();
      } else if (platform === 'amazon') {
        data = scrapeAmazon();
      }

      if (!data || data.images.length === 0) {
        showToast('No images found on this page!', 'warning');
        return;
      }

      showToast(`Found ${data.images.length} image(s)!`, 'success');
      showImageModal(data);
    });

    container.querySelector('.vh-scrape-btn-page').addEventListener('click', async () => {
      const platform = detectPlatform();
      if (platform !== 'etsy') {
        showToast('Page scrape is only supported on Etsy search pages', 'warning');
        return;
      }

      const btn = container.querySelector('.vh-scrape-btn-page');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Scanning page...';

      try {
        const data = scrapeEtsySearchPage();
        if (!data.items || data.items.length === 0) {
          showToast('No products found on this page!', 'warning');
          return;
        }

        showToast(`Found ${data.items.length} products. Downloading images...`, 'info');

        const images = [];
        for (let i = 0; i < data.items.length; i++) {
          btn.textContent = `Downloading ${i + 1}/${data.items.length}...`;
          try {
            console.log(`[VH] Downloading image ${i + 1}: ${data.items[i].imageUrl?.substring(0, 80)}`);
            const imgData = await downloadImageAsBase64(data.items[i].imageUrl);
            if (imgData && imgData.base64) {
              console.log(`[VH] Downloaded ${i + 1}: base64 length = ${imgData.base64.length}`);
              images.push({
                title: data.items[i].title,
                ...imgData,
              });
            } else {
              console.warn(`[VH] Image ${i + 1} returned empty data`);
            }
          } catch (dlErr) {
            console.warn('[VH] Failed to download listing image:', dlErr);
          }
        }

        if (images.length === 0) {
          showToast('No images could be downloaded on this page!', 'error');
          return;
        }

        console.log(`[VH] Total images to upload: ${images.length}`);

        // First, create the folder via background
        btn.textContent = `Creating folder...`;
        if (!chrome?.runtime?.sendMessage) {
          showToast('❌ Extension disconnected. Please refresh the page (F5).', 'error');
          return;
        }
        
        // Create folder first
        const folderResponse = await chrome.runtime.sendMessage({
          type: 'CREATE_DRIVE_FOLDER_FOR_LISTINGS',
          payload: {
            folderId: DRIVE_FOLDER_ID,
            pageTitle: data.pageTitle,
          },
        });

        if (!folderResponse?.ok) {
          const errMsg = folderResponse?.error || 'Failed to create folder';
          showToast(`❌ ${errMsg}`, 'error');
          return;
        }

        const targetFolderId = folderResponse.folderId;
        const targetDriveId = folderResponse.driveId || null; // For Shared Drive support
        console.log(`[VH] Created folder: ${targetFolderId}${targetDriveId ? ' (Shared Drive: ' + targetDriveId + ')' : ''}`);

        // Upload images one by one to avoid message size limits
        let uploadedCount = 0;
        const nameCounts = {};
        
        console.log(`[VH] Starting upload loop for ${images.length} images...`);
        
        for (let i = 0; i < images.length; i++) {
          const item = images[i];
          btn.textContent = `Uploading ${i + 1}/${images.length}...`;
          
          console.log(`[VH] Processing upload ${i + 1}/${images.length}...`);
          
          const baseName = (item.title || 'Item')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 200);
          
          nameCounts[baseName] = (nameCounts[baseName] || 0) + 1;
          const suffix = nameCounts[baseName] > 1 ? `_${nameCounts[baseName]}` : '';
          const fileName = `${baseName}${suffix}`;

          console.log(`[VH] Sending upload request for: ${fileName} (base64 length: ${item.base64?.length || 0})`);

          try {
            // Check if extension context is still valid
            if (!chrome?.runtime?.id) {
              console.error('[VH] Extension context invalidated!');
              showToast('❌ Extension disconnected. Please refresh the page.', 'error');
              return;
            }

            const uploadResponse = await chrome.runtime.sendMessage({
              type: 'UPLOAD_SINGLE_IMAGE_TO_DRIVE',
              payload: {
                base64: item.base64,
                mimeType: item.mimeType,
                fileName: fileName,
                folderId: targetFolderId,
                driveId: targetDriveId, // Pass driveId for Shared Drive
              },
            });

            console.log(`[VH] Upload response for ${i + 1}:`, uploadResponse);

            if (uploadResponse?.ok) {
              uploadedCount++;
              console.log(`[VH] ✅ Uploaded ${i + 1}/${images.length}: ${fileName}`);
            } else {
              console.warn(`[VH] ❌ Failed to upload ${fileName}: ${uploadResponse?.error}`);
            }
            
            // Small delay to prevent overwhelming the service worker
            await Utils.wait(100);
            
          } catch (uploadErr) {
            console.error(`[VH] Upload error for ${fileName}:`, uploadErr);
            // If extension context is invalid, stop
            if (uploadErr.message?.includes('Extension context invalidated')) {
              showToast('❌ Extension disconnected. Please refresh the page.', 'error');
              break;
            }
          }
        }
        
        console.log(`[VH] Upload loop finished. Total uploaded: ${uploadedCount}/${images.length}`);

        if (uploadedCount > 0) {
          showToast(`✅ ${uploadedCount}/${images.length} image(s) uploaded!`, 'success');
        } else {
          showToast('❌ No images could be uploaded. Check console for details.', 'error');
        }
      } catch (err) {
        console.error('[VH] Page scrape error:', err);
        showToast(`❌ Error: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  }

  // ─── Initialize ───
  function init() {
    const platform = detectPlatform();
    if (!platform) return;

    console.log(`[VH] Image Scraper loaded on ${platform}`);
    injectStyles();
    addScrapeButton();
  }

  // Wait for page to load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay for SPAs
    setTimeout(init, 1500);
  }
})();
