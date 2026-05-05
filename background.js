/**
 * VH Extension - Background Service Worker
 * Handles API calls for both AliExpress import and Etsy order sync
 */

const API_TIMEOUT_MS = 60000; // 60 seconds

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = API_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

// ─── Google Drive Helper Functions ───

const OAUTH_CLIENT_ID = '766365154043-gldq7hg857aiqganf7qc8hdhdma48b3o.apps.googleusercontent.com';
const OAUTH_WEB_CLIENT_ID = '766365154043-1gp4fq9tcrsbrug9gv7hpdeoi15q6fuo.apps.googleusercontent.com';
const OAUTH_SCOPES = 'https://www.googleapis.com/auth/drive';

/**
 * Get Google OAuth token - tries getAuthToken first, falls back to launchWebAuthFlow
 */
async function getGoogleAuthToken(interactive = true) {
  console.log(`🔑 [SW] getAuthToken called (interactive=${interactive}), extension ID: ${chrome.runtime.id}`);

  // Try standard getAuthToken first (quick, 10s timeout)
  if (interactive) {
    try {
      const token = await _rawGetAuthToken(true, 10000);
      if (token) {
        console.log('✅ [SW] getAuthToken (standard) success');
        return token;
      }
    } catch (err) {
      console.warn('🔑 [SW] Standard getAuthToken failed:', err.message, '→ trying launchWebAuthFlow');
    }
  }

  // Fallback: launchWebAuthFlow (always works, opens popup)
  if (interactive) {
    try {
      const token = await _launchWebAuthFlow();
      if (token) {
        console.log('✅ [SW] launchWebAuthFlow success');
        return token;
      }
    } catch (err) {
      console.error('❌ [SW] launchWebAuthFlow failed:', err.message);
      throw err;
    }
  }

  // Non-interactive: check stored token
  const stored = await chrome.storage.local.get('gdrive_token');
  if (stored.gdrive_token) {
    // Verify token is still valid
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=' + stored.gdrive_token);
      if (res.ok) return stored.gdrive_token;
    } catch (e) {}
    await chrome.storage.local.remove('gdrive_token');
  }

  throw new Error('Not authenticated');
}

/**
 * Standard chrome.identity.getAuthToken with timeout
 */
function _rawGetAuthToken(interactive, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Auth timeout (${timeout/1000}s)`));
    }, timeout);

    chrome.identity.getAuthToken({ interactive }, (token) => {
      clearTimeout(timeoutId);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

/**
 * Fallback: Use launchWebAuthFlow for OAuth (works when getAuthToken hangs)
 */
async function _launchWebAuthFlow() {
  const redirectUrl = chrome.identity.getRedirectURL();
  console.log('🔑 [SW] Redirect URL:', redirectUrl);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', OAUTH_WEB_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUrl);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('prompt', 'consent');

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  // Extract access_token from the redirect URL fragment
  const url = new URL(responseUrl);
  const hashParams = new URLSearchParams(url.hash.substring(1));
  const accessToken = hashParams.get('access_token');

  if (!accessToken) {
    throw new Error('No access token in response');
  }

  // Store token for non-interactive checks
  await chrome.storage.local.set({ gdrive_token: accessToken });

  return accessToken;
}

/**
 * Remove cached Google Auth token (for re-auth)
 */
async function removeCachedAuthToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

/**
 * Download image as blob via fetch
 */
async function downloadImage(imageUrl) {
  const res = await fetchWithTimeout(imageUrl, { timeout: 30000 });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const blob = await res.blob();
  return blob;
}

/**
 * Upload a single image to Google Drive (supports Shared Drives)
 */
async function uploadToDrive(token, blob, fileName, folderId, mimeType, driveId = null) {
  const metadata = {
    name: fileName,
    parents: [folderId],
  };

  // Build multipart body
  const boundary = '-------VH_BOUNDARY_' + Date.now();
  const metadataStr = JSON.stringify(metadata);

  // Convert blob to ArrayBuffer
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  // Build the multipart request body
  const beforeFile =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadataStr}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n` +
    `Content-Transfer-Encoding: binary\r\n\r\n`;

  const afterFile = `\r\n--${boundary}--`;

  // Encode strings to Uint8Array
  const encoder = new TextEncoder();
  const beforeBytes = encoder.encode(beforeFile);
  const afterBytes = encoder.encode(afterFile);

  // Combine all parts
  const totalLength = beforeBytes.length + uint8Array.length + afterBytes.length;
  const body = new Uint8Array(totalLength);
  body.set(beforeBytes, 0);
  body.set(uint8Array, beforeBytes.length);
  body.set(afterBytes, beforeBytes.length + uint8Array.length);

  // Build URL with Shared Drive support
  let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true';
  if (driveId) {
    url += `&driveId=${driveId}&includeItemsFromAllDrives=true`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: body.buffer,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Drive upload failed (${res.status}): ${errorText}`);
  }

  return await res.json();
}

/**
 * Create a folder in Google Drive (supports Shared Drives)
 */
async function createDriveFolder(token, folderName, parentFolderId, driveId = null) {
  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentFolderId) {
    metadata.parents = [parentFolderId];
  }

  // For Shared Drives, we need to specify driveId in the URL
  let url = 'https://www.googleapis.com/drive/v3/files?fields=id,name&supportsAllDrives=true';
  if (driveId) {
    url += `&driveId=${driveId}&includeItemsFromAllDrives=true`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to create folder (${res.status}): ${errorText}`);
  }

  return await res.json();
}

/**
 * Get or create a "Crawl" folder in user's Drive root.
 * Used as fallback when target folder is not accessible.
 */
async function getOrCreateCrawlFolder(token) {
  // Search for existing "Crawl" folder in root
  const query = encodeURIComponent("name='Crawl' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false");
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&spaces=drive`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (searchRes.ok) {
    const data = await searchRes.json();
    if (data.files && data.files.length > 0) {
      console.log('📁 [SW] Found existing "Crawl" folder:', data.files[0].id);
      return data.files[0].id;
    }
  }

  // Create new "Crawl" folder in root
  console.log('📁 [SW] Creating new "Crawl" folder in Drive root...');
  const folder = await createDriveFolder(token, 'Crawl', null);
  console.log('📁 [SW] Created "Crawl" folder:', folder.id);
  return folder.id;
}

/**
 * Resolve the target Drive folder ID.
 * Tries the specified folder first, falls back to creating "Crawl" in root.
 * Returns { folderId, driveId } where driveId is set for Shared Drives.
 */
async function resolveTargetFolder(token, folderId) {
  if (folderId) {
    try {
      // Check if folder is accessible and get driveId for Shared Drives
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,driveId&supportsAllDrives=true`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (res.ok) {
        const data = await res.json();
        console.log(`📁 [SW] Target folder accessible: "${data.name}" (${data.id}), driveId: ${data.driveId || 'none (My Drive)'}`);
        return { folderId, driveId: data.driveId || null };
      }
      console.warn(`📁 [SW] Target folder ${folderId} not accessible (${res.status}), using fallback`);
    } catch (e) {
      console.warn('📁 [SW] Error checking target folder:', e.message);
    }
  }

  // Fallback: use/create "Crawl" folder in user's Drive root
  const fallbackId = await getOrCreateCrawlFolder(token);
  return { folderId: fallbackId, driveId: null };
}

/**
 * Determine mime type from URL or default
 */
function getMimeTypeFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.gif')) return 'image/gif';
  if (lower.includes('.bmp')) return 'image/bmp';
  return 'image/jpeg'; // default
}

/**
 * Get file extension from mime type
 */
function getExtFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
  };
  return map[mime] || '.jpg';
}

// ─── Main Message Listener ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('🔷 [SW] Message received:', message?.type);

  // === DOWNLOAD IMAGE AS BASE64 (for CORS-restricted images) ===
  if (message?.type === 'DOWNLOAD_IMAGE_AS_BASE64') {
    (async () => {
      try {
        const { url } = message.payload || {};
        if (!url) throw new Error('No URL provided');

        console.log(`📥 [SW] Downloading image: ${url.substring(0, 80)}...`);
        const res = await fetchWithTimeout(url, { timeout: 30000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const blob = await res.blob();
        const mimeType = blob.type || getMimeTypeFromUrl(url);

        // Convert blob to base64
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < uint8Array.length; i++) {
          binary += String.fromCharCode(uint8Array[i]);
        }
        const base64 = btoa(binary);

        console.log(`✅ [SW] Downloaded: ${(blob.size / 1024).toFixed(1)}KB, ${mimeType}`);
        sendResponse({ ok: true, base64, mimeType, url });
      } catch (err) {
        console.error('❌ [SW] Download failed:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === UPLOAD IMAGES TO GOOGLE DRIVE ===
  // Images are now sent as base64 data from content script
  if (message?.type === 'UPLOAD_IMAGES_TO_DRIVE') {
    (async () => {
      try {
        const { images, title, folderId, platform } = message.payload || {};
        if (!images || images.length === 0) throw new Error('No images provided');

        // Get Google auth token
        let token;
        try {
          token = await getGoogleAuthToken(true);
        } catch (authErr) {
          sendResponse({ ok: false, error: 'Google Drive not authenticated. Please connect your Google account.' });
          return;
        }

        if (!token) {
          sendResponse({ ok: false, error: 'Failed to get OAuth token' });
          return;
        }

        console.log(`🟢 [SW] Uploading ${images.length} images to Drive...`);

        // Resolve target folder (fallback to Crawl in root if original not accessible)
        const resolved = await resolveTargetFolder(token, folderId);
        console.log(`📁 [SW] Resolved target folder: ${resolved.folderId}, driveId: ${resolved.driveId || 'none'}`);

        const sanitizedTitle = (title || 'Untitled')
          .replace(/[\\/:*?"<>|]/g, '_')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 200);

        // Create a subfolder with the product title
        console.log(`📁 [SW] Creating folder "${sanitizedTitle}"...`);
        const folder = await createDriveFolder(token, sanitizedTitle, resolved.folderId, resolved.driveId);
        const targetFolderId = folder.id;
        const targetDriveId = resolved.driveId;
        console.log(`📁 [SW] Folder created: ${folder.name} (${folder.id})`);

        let uploadedCount = 0;
        const results = [];

        for (let i = 0; i < images.length; i++) {
          try {
            const imgData = images[i]; // { base64, mimeType, url }
            const mimeType = imgData.mimeType || 'image/jpeg';
            const ext = getExtFromMime(mimeType);

            // File name: title_index
            const fileName = images.length === 1
              ? `${sanitizedTitle}${ext}`
              : `${sanitizedTitle}_${i + 1}${ext}`;

            // Convert base64 to blob
            const byteCharacters = atob(imgData.base64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let j = 0; j < byteCharacters.length; j++) {
              byteNumbers[j] = byteCharacters.charCodeAt(j);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });

            console.log(`📤 [SW] Uploading "${fileName}" (${(blob.size / 1024).toFixed(1)}KB) to Drive...`);
            const result = await uploadToDrive(token, blob, fileName, targetFolderId, mimeType, targetDriveId);

            results.push(result);
            uploadedCount++;
            console.log(`✅ [SW] Uploaded: ${result.name} (${result.id})`);
          } catch (imgErr) {
            console.error(`❌ [SW] Failed image ${i + 1}:`, imgErr.message);

            // If 401, try refresh token and retry
            if (imgErr.message.includes('401')) {
              try {
                await removeCachedAuthToken(token);
                token = await getGoogleAuthToken(false);
                // Retry this image
                i--;
                continue;
              } catch (refreshErr) {
                console.error('[SW] Token refresh failed:', refreshErr);
              }
            }
          }
        }

        sendResponse({ ok: true, uploaded: uploadedCount, total: images.length, results });
      } catch (err) {
        console.error('🔴 [SW] Upload error:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === CREATE FOLDER FOR LISTINGS (step 1 of individual upload) ===
  if (message?.type === 'CREATE_DRIVE_FOLDER_FOR_LISTINGS') {
    (async () => {
      try {
        const { folderId, pageTitle } = message.payload || {};

        // Get Google auth token
        let token;
        try {
          token = await getGoogleAuthToken(true);
        } catch (authErr) {
          sendResponse({ ok: false, error: 'Google Drive not authenticated. Please connect your Google account.' });
          return;
        }

        if (!token) {
          sendResponse({ ok: false, error: 'Failed to get OAuth token' });
          return;
        }

        // Resolve target folder (returns { folderId, driveId })
        const resolved = await resolveTargetFolder(token, folderId);
        console.log(`📁 [SW] Resolved target folder: ${resolved.folderId}, driveId: ${resolved.driveId || 'none'}`);

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
        const rawTitle = (pageTitle || 'Etsy Search').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
        const folderName = `${rawTitle}_${timestamp}`.substring(0, 200);

        console.log(`📁 [SW] Creating folder "${folderName}" in ${resolved.driveId ? 'Shared Drive' : 'My Drive'}...`);
        const folder = await createDriveFolder(token, folderName, resolved.folderId, resolved.driveId);
        console.log(`✅ [SW] Folder created: ${folder.name} (${folder.id})`);

        // Return driveId so subsequent uploads can use it
        sendResponse({ ok: true, folderId: folder.id, folderName: folder.name, driveId: resolved.driveId });
      } catch (err) {
        console.error('🔴 [SW] Create folder error:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === UPLOAD SINGLE IMAGE TO DRIVE ===
  if (message?.type === 'UPLOAD_SINGLE_IMAGE_TO_DRIVE') {
    console.log(`📥 [SW] Received UPLOAD_SINGLE_IMAGE_TO_DRIVE request`);
    (async () => {
      try {
        const { base64, mimeType, fileName, folderId, driveId } = message.payload || {};

        console.log(`📥 [SW] Upload request details: fileName="${fileName}", folderId="${folderId}", driveId="${driveId || 'none'}", base64Length=${base64?.length || 0}`);

        if (!base64) throw new Error('No image data provided');
        if (!folderId) throw new Error('No folder ID provided');

        // Get Google auth token (non-interactive, should already be authenticated)
        let token;
        try {
          token = await getGoogleAuthToken(false);
        } catch (authErr) {
          // Try interactive
          token = await getGoogleAuthToken(true);
        }

        if (!token) {
          sendResponse({ ok: false, error: 'Failed to get OAuth token' });
          return;
        }

        const mime = mimeType || 'image/jpeg';
        const ext = getExtFromMime(mime);
        const fullFileName = `${fileName}${ext}`;

        // Convert base64 to blob
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let j = 0; j < byteCharacters.length; j++) {
          byteNumbers[j] = byteCharacters.charCodeAt(j);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: mime });

        console.log(`📤 [SW] Uploading "${fullFileName}" (${(blob.size / 1024).toFixed(1)}KB) to folder ${folderId}${driveId ? ' in Shared Drive' : ''}...`);

        // Upload with retry logic
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const result = await uploadToDrive(token, blob, fullFileName, folderId, mime, driveId);
            console.log(`✅ [SW] Uploaded: ${result.name} (${result.id})`);
            sendResponse({ ok: true, fileId: result.id, fileName: result.name });
            return;
          } catch (uploadErr) {
            lastError = uploadErr;
            console.warn(`⚠️ [SW] Upload attempt ${attempt} failed: ${uploadErr.message}`);
            if (attempt < 3) {
              // Wait before retry (exponential backoff)
              await new Promise(r => setTimeout(r, 1000 * attempt));
            }
          }
        }
        throw lastError;
      } catch (err) {
        console.error('🔴 [SW] Single image upload error:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === UPLOAD LISTING IMAGES (BULK) TO GOOGLE DRIVE ===
  if (message?.type === 'UPLOAD_LISTINGS_TO_DRIVE') {
    (async () => {
      try {
        const { items, folderId, pageTitle } = message.payload || {};
        if (!items || items.length === 0) throw new Error('No images provided');

        // Get Google auth token
        let token;
        try {
          token = await getGoogleAuthToken(true);
        } catch (authErr) {
          sendResponse({ ok: false, error: 'Google Drive not authenticated. Please connect your Google account.' });
          return;
        }

        if (!token) {
          sendResponse({ ok: false, error: 'Failed to get OAuth token' });
          return;
        }

        // Resolve target folder (fallback to Crawl in root if original not accessible)
        const resolved = await resolveTargetFolder(token, folderId);
        console.log(`📁 [SW] Resolved target folder: ${resolved.folderId}, driveId: ${resolved.driveId || 'none'}`);

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
        const rawTitle = (pageTitle || 'Etsy Search').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
        const folderName = `${rawTitle}_${timestamp}`.substring(0, 200);

        console.log(`📁 [SW] Creating folder "${folderName}"...`);
        const folder = await createDriveFolder(token, folderName, resolved.folderId, resolved.driveId);
        const targetFolderId = folder.id;
        const targetDriveId = resolved.driveId;

        let uploadedCount = 0;
        const nameCounts = {};

        console.log(`📤 [SW] Starting upload of ${items.length} items...`);

        for (let i = 0; i < items.length; i++) {
          try {
            const item = items[i];

            // Debug: Check if item has required data
            if (!item.base64) {
              console.warn(`⚠️ [SW] Item ${i + 1} has no base64 data, skipping`);
              continue;
            }

            console.log(`📤 [SW] Uploading item ${i + 1}/${items.length}: ${item.title?.substring(0, 30)}... (base64 length: ${item.base64?.length || 0})`);

            const mimeType = item.mimeType || 'image/jpeg';
            const ext = getExtFromMime(mimeType);

            const baseName = (item.title || 'Item')
              .replace(/[\\/:*?"<>|]/g, '_')
              .replace(/\s+/g, ' ')
              .trim()
              .substring(0, 200);

            nameCounts[baseName] = (nameCounts[baseName] || 0) + 1;
            const suffix = nameCounts[baseName] > 1 ? `_${nameCounts[baseName]}` : '';
            const fileName = `${baseName}${suffix}${ext}`;

            // Convert base64 to blob
            const byteCharacters = atob(item.base64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let j = 0; j < byteCharacters.length; j++) {
              byteNumbers[j] = byteCharacters.charCodeAt(j);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });

            console.log(`📤 [SW] Uploading "${fileName}" (${(blob.size / 1024).toFixed(1)}KB)...`);
            const result = await uploadToDrive(token, blob, fileName, targetFolderId, mimeType, targetDriveId);
            console.log(`✅ [SW] Uploaded: ${result.name} (${result.id})`);
            uploadedCount++;
          } catch (imgErr) {
            console.error(`❌ [SW] Failed listing image ${i + 1}:`, imgErr.message, imgErr.stack);

            if (imgErr.message.includes('401')) {
              try {
                await removeCachedAuthToken(token);
                token = await getGoogleAuthToken(false);
                i--;
                continue;
              } catch (refreshErr) {
                console.error('[SW] Token refresh failed:', refreshErr);
              }
            }
          }
        }

        sendResponse({ ok: true, uploaded: uploadedCount, total: items.length, folderId: targetFolderId });
      } catch (err) {
        console.error('🔴 [SW] Bulk upload error:', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === GOOGLE DRIVE: Check Auth ===
  if (message?.type === 'GDRIVE_CHECK_AUTH') {
    (async () => {
      try {
        const token = await getGoogleAuthToken(false);
        sendResponse({ ok: true, authenticated: !!token });
      } catch (err) {
        sendResponse({ ok: true, authenticated: false });
      }
    })();
    return true;
  }

  // === GOOGLE DRIVE: Connect ===
  if (message?.type === 'GDRIVE_CONNECT') {
    (async () => {
      try {
        console.log('🔗 [SW] GDRIVE_CONNECT: clearing old token first...');
        // Clear any cached token (old scope) before requesting new one
        try {
          const oldToken = await getGoogleAuthToken(false);
          if (oldToken) {
            await removeCachedAuthToken(oldToken);
            console.log('🔗 [SW] Old token cleared');
          }
        } catch (e) {
          console.log('🔗 [SW] No old token to clear');
        }

        console.log('🔗 [SW] Requesting new token with interactive=true...');
        const token = await getGoogleAuthToken(true);
        console.log('🔗 [SW] GDRIVE_CONNECT: auth result:', !!token);
        sendResponse({ ok: true, authenticated: !!token });
      } catch (err) {
        console.error('🔗 [SW] GDRIVE_CONNECT error:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === GOOGLE DRIVE: Disconnect ===
  if (message?.type === 'GDRIVE_DISCONNECT') {
    (async () => {
      try {
        const token = await getGoogleAuthToken(false);
        if (token) {
          await removeCachedAuthToken(token);
          // Revoke the token
          await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: true }); // still treat as success
      }
    })();
    return true;
  }

  // === ALIEXPRESS: Import Product ===
  if (message?.type === 'EX_API_POST_PRODUCT') {
    (async () => {
      try {
        const { url, data, token } = message.payload || {};
        if (!url || !data) throw new Error('Missing url or data');
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify(data)
        });
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, body: text });
      } catch (err) {
        sendResponse({ ok: false, status: 0, body: String(err) });
      }
    })();
    return true;
  }

  // === ETSY: Sync Orders ===
  if (message?.type === 'ETSY_API_POST') {
    (async () => {
      try {
        const { url, data, token } = message.payload || {};

        if (!url || !data) throw new Error('Missing url or data');

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify(data)
        });

        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, body: text });
      } catch (err) {
        console.error('[SW] ETSY_API_POST failed:', err.message);
        sendResponse({ ok: false, status: 0, body: `${err.name}: ${err.message}` });
      }
    })();
    return true;
  }

  // === ETSY: Login ===
  if (message?.type === 'ETSY_LOGIN') {
    (async () => {
      try {
        const { url, username, password } = message.payload || {};
        if (!url || !username || !password) throw new Error('Missing login data');

        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            'email-username': username,
            'password': password
          })
        });

        if (!res.ok) throw new Error('Invalid credentials');

        const data = await res.json();
        await chrome.storage.local.set({
          accessToken: data.access,
          refreshToken: data.refresh,
          username: data.username
        });

        console.log('🟢 [SW] Login success:', data.username);
        sendResponse({ ok: true, data: { username: data.username } });
      } catch (err) {
        console.error('🔴 [SW] Login error:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === ETSY: Logout ===
  if (message?.type === 'ETSY_LOGOUT') {
    (async () => {
      try {
        await chrome.storage.local.remove(['accessToken', 'refreshToken', 'username']);
        console.log('🟢 [SW] Logout success');
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === ETSY: Check Auth ===
  if (message?.type === 'ETSY_CHECK_AUTH') {
    (async () => {
      try {
        const { refreshToken, username } = await chrome.storage.local.get(['refreshToken', 'username']);
        sendResponse({ ok: true, data: { isAuthenticated: !!refreshToken, username } });
      } catch (err) {
        sendResponse({ ok: false, data: { isAuthenticated: false } });
      }
    })();
    return true;
  }

  // === ETSY: Refresh Token ===
  if (message?.type === 'ETSY_REFRESH_TOKEN') {
    (async () => {
      try {
        const { url, refreshToken } = message.payload || {};
        if (!url || !refreshToken) throw new Error('Missing refresh data');

        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh: refreshToken })
        });

        if (!res.ok) throw new Error('Failed to refresh token');

        const data = await res.json();
        await chrome.storage.local.set({ accessToken: data.access });

        console.log('🟢 [SW] Token refreshed');
        sendResponse({ ok: true, accessToken: data.access });
      } catch (err) {
        console.error('🔴 [SW] Refresh error:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === AUTO SYNC: Toggle ===
  if (message?.type === 'TOGGLE_AUTO_SYNC') {
    (async () => {
      try {
        const { enabled, intervalMinutes } = message.payload || {};

        // Clear existing alarm
        await chrome.alarms.clear('autoSyncAlarm');

        if (enabled) {
          // Create new alarm
          await chrome.alarms.create('autoSyncAlarm', {
            delayInMinutes: intervalMinutes || 5,
            periodInMinutes: intervalMinutes || 5
          });
          console.log(`🟢 [SW] Auto sync enabled: every ${intervalMinutes} minutes`);
        } else {
          console.log('🟡 [SW] Auto sync disabled');
        }

        sendResponse({ ok: true });
      } catch (err) {
        console.error('🔴 [SW] Auto sync toggle error:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // === AUTO SYNC: Get Status ===
  if (message?.type === 'GET_AUTO_SYNC_STATUS') {
    (async () => {
      try {
        const alarm = await chrome.alarms.get('autoSyncAlarm');
        const settings = await chrome.storage.local.get(['autoSync', 'autoSyncInterval']);
        sendResponse({
          ok: true,
          data: {
            enabled: !!alarm,
            intervalMinutes: settings.autoSyncInterval || 5,
            nextSync: alarm?.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : null
          }
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});

// === ALARM LISTENER: Auto Sync ===
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autoSyncAlarm') {
    console.log('🔄 [SW] Auto sync alarm triggered');

    try {
      // Get shop name and auth
      const { etsyShopName, refreshToken, accessToken } = await chrome.storage.local.get(['etsyShopName', 'refreshToken', 'accessToken']);

      if (!etsyShopName || !refreshToken) {
        console.log('🟡 [SW] Auto sync skipped: not configured');
        return;
      }

      // Find Etsy order tabs
      const tabs = await chrome.tabs.query({ url: '*://www.etsy.com/your/orders/*' });

      if (tabs.length === 0) {
        console.log('🟡 [SW] Auto sync skipped: no Etsy order tabs open');
        return;
      }

      // Send message to first Etsy tab to trigger sync
      for (const tab of tabs) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_AUTO_SYNC' });
          console.log(`🟢 [SW] Auto sync triggered on tab ${tab.id}`);
          break; // Only trigger on first tab
        } catch (e) {
          console.log(`🟡 [SW] Could not reach tab ${tab.id}:`, e.message);
        }
      }
    } catch (err) {
      console.error('🔴 [SW] Auto sync error:', err.message);
    }
  }
});

// === STARTUP: Restore auto sync alarm - enabled by default (5 minutes) ===
chrome.runtime.onStartup.addListener(async () => {
  try {
    const settings = await chrome.storage.local.get(['autoSync', 'autoSyncInterval']);

    // Enable auto sync by default if not explicitly set
    if (settings.autoSync === undefined) {
      await chrome.storage.local.set({ autoSync: true, autoSyncInterval: 5 });
      settings.autoSync = true;
      settings.autoSyncInterval = 5;
      console.log('🟢 [SW] Auto sync enabled by default on startup (5 minutes)');
    }

    if (settings.autoSync) {
      await chrome.alarms.create('autoSyncAlarm', {
        delayInMinutes: settings.autoSyncInterval || 5,
        periodInMinutes: settings.autoSyncInterval || 5
      });
      console.log('🟢 [SW] Auto sync restored on startup');
    }
  } catch (err) {
    console.error('🔴 [SW] Failed to restore auto sync:', err.message);
  }
});

// === INSTALLED: Setup auto sync - enabled by default (5 minutes) ===
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const settings = await chrome.storage.local.get(['autoSync', 'autoSyncInterval']);

    // Enable auto sync by default if not explicitly set
    if (settings.autoSync === undefined) {
      await chrome.storage.local.set({ autoSync: true, autoSyncInterval: 5 });
      settings.autoSync = true;
      settings.autoSyncInterval = 5;
      console.log('🟢 [SW] Auto sync enabled by default (5 minutes)');
    }

    if (settings.autoSync) {
      await chrome.alarms.create('autoSyncAlarm', {
        delayInMinutes: settings.autoSyncInterval || 5,
        periodInMinutes: settings.autoSyncInterval || 5
      });
      console.log('🟢 [SW] Auto sync alarm setup on install');
    }
  } catch (err) {
    console.error('🔴 [SW] Failed to setup auto sync:', err.message);
  }
});
