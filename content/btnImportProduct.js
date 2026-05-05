console.log('🔥🔥🔥 btnImportProduct.js LOADED! 🔥🔥🔥', window.location.href);

let htmlTemplate = `<div class="import-button-container">
    <div class="design-count-wrapper" style="margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
      <label for="designCountInput" style="color: #fff; font-size: 12px; font-weight: 600; white-space: nowrap;">Designs:</label>
      <input type="number" id="designCountInput" min="0" max="50" value="0"
             style="width: 52px; padding: 4px 6px; border-radius: 6px; border: 1px solid #ccc; font-size: 13px; text-align: center;" />
    </div>
    <button class="import-button" style="display: flex; gap: 5px;">
     <div class="spinner-border spinner-border-sm" role="status" style="display: none;"></div> <div>Import products</div></button>
</div>`;

const manifest = chrome.runtime.getManifest();
const apiUrl = manifest.api_url;

window.onload = async() => {
    // Load CSS
    try {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.type = "text/css";
        link.href = chrome.runtime.getURL('css/btnallScript.css');
        document.head.appendChild(link);
        console.log('✅ CSS loaded successfully');
    } catch(e) {
        console.warn('⚠️ Failed to load CSS:', e);
    }

    if (window.location.host.includes('temu.com')) {
      wrapperObject = document.querySelector('.product-buy--container') || document.body;
    } else if (window.location.host.includes('etsy.com')) {
      wrapperObject = document.querySelector('[data-buy-box-region="price"]') ||
                      document.querySelector('[data-component="listing-page-cart"]') ||
                      document.body;
    } else if (window.location.host.includes('amazon.')) {
      wrapperObject = document.querySelector('#rightCol') ||
                      document.querySelector('#buybox') ||
                      document.querySelector('#desktop_buybox') ||
                      document.body;
    } else {
      wrapperObject = document.querySelector("#root") || document.querySelector("#__next") || document.body;
    }
    if (wrapperObject) {
        wrapperObject.insertAdjacentHTML('beforeend', htmlTemplate);
        const importButton = wrapperObject.querySelector(".import-button");
        const { accessToken } = await chrome.storage.local.get('accessToken');
        const { refreshToken } = await chrome.storage.local.get('refreshToken');
        const loadingContainer = wrapperObject.querySelector(".spinner-border");
        importButton.addEventListener("click", async () => {
          // 1) Đảm bảo có refreshToken
          const { refreshToken } = await chrome.storage.local.get('refreshToken');
          if (!refreshToken) {
            alert('Please login.');
            return;
          }

          // 2) Lấy access token hiện tại
          let { accessToken } = await chrome.storage.local.get('accessToken');

          // 3) Nếu hết hạn, refresh và cập nhật lại accessToken
          if (isAccessTokenExpired(accessToken)) {
            accessToken = await refreshAccessToken();
          }

          importButton.classList.add('loading');
          loadingContainer.style.display = "block";

          let productData; // cần ở scope ngoài để có thể retry trong catch
          try {
            console.log('🚀 Bắt đầu scrape dữ liệu sản phẩm...');
            productData = await scrapeProductData();

            // ── Expand variants with Design numbers ──
            const designCountInput = document.getElementById('designCountInput');
            const designCount = parseInt(designCountInput?.value) || 0;
            if (designCount > 0 && productData.variants && productData.variants.length > 0) {
              const expandedVariants = [];
              for (const variant of productData.variants) {
                for (let d = 1; d <= designCount; d++) {
                  const newVariant = { ...variant, design: String(d) };
                  // Clone primary_image nếu có
                  if (variant.primary_image) {
                    newVariant.primary_image = { ...variant.primary_image };
                  }
                  expandedVariants.push(newVariant);
                }
              }
              productData.variants = expandedVariants;
              console.log(`🎨 Expanded variants with ${designCount} designs → ${expandedVariants.length} total variants`);
            }

            console.log('📦 Product data scraped:', productData);

            console.log("🛫 Sending to API with token:", accessToken);
            const result = await sendProductDataToAPI(productData, accessToken);

            if (result) {
              alert('Import success.');
            }
          } catch (error) {
            console.error("⚠️ Import failed:", error);

            // 4) Nếu vẫn 401, thử refresh token lần nữa và retry
            if (/401/.test(error.message)) {
              try {
                accessToken = await refreshAccessToken();
                console.log("Retry with new token:", accessToken);
                const retry = await sendProductDataToAPI(productData, accessToken);
                if (retry) {
                  alert('Import success (after token refresh).');
                  return;
                }
              } catch (e2) {
                console.error("Retry cũng lỗi:", e2);
              }
            }

            alert(`Lỗi: ${error.message || error}`);
          } finally {
            loadingContainer.style.display = "none";
            importButton.classList.remove('loading');
          }
        });
    }
};


function cartesian(arrays) {
  return arrays.reduce((a, b) =>
    a.flatMap(x => b.map(y => x.concat(y))),
    [[]]
  );
}
function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function modifyImageUrl(url) {
    return url.replace(/(w\/)(\d+)/, '$1600'); // Thay đổi w/180 thành w/480
}
function resizeImageUrl(url) {
    // Check if the URL contains the width and replace it with 600
    return url.replace(/(\d+)x(\d+)/, '600x600'); // Replace width and height with 600
}


function removeDuplicates(array) {
    const uniqueUrls = [];
    const seenUrls = new Set();
    array.forEach(item => {
        if (!seenUrls.has(item.url)) {
            seenUrls.add(item.url);
            uniqueUrls.push(item);
        }
    });
    return uniqueUrls;
}


async function scrapeAliExpressData() {
  console.log('🛒 === SCRAPING ALIEXPRESS ===');

  const normalize = str => (str || '').trim().toLowerCase();
  const waitTime = ms => new Promise(res => setTimeout(res, ms));
  const safeText = el => el?.textContent?.trim() || '';

  let titleProduct = '';
  let thumbnailImages = [];
  let variantsData = [];
  let description = '';

  window.scrollTo(0, document.documentElement.scrollHeight);
  await waitTime(1000);

  const pdpLeftWrap = document.querySelector('.pdp-info-left');
  const pdprightWrap = document.querySelector('.pdp-info-right');
  const currencyEl = document.querySelector('[class^="ship-to--text"] b');
  const currency = currencyEl?.textContent.trim() || null;

  console.log('💱 [ALIEXPRESS] Currency:', currency);

const ctnDescription = document.querySelector('[data-pl="product-description"]');
if (ctnDescription) {
  // 1) Xóa img, table và các thẻ không cho phép
  ctnDescription
    .querySelectorAll('img, table, thead, tbody, tr, th, td, a[href], iframe[src], script, video[src]')
    .forEach(el => el.remove());

  // 2) Gỡ hết inline attributes
  ctnDescription.querySelectorAll('*').forEach(el => {
    el.removeAttribute('style');
    el.removeAttribute('class');
    el.removeAttribute('align');
    el.removeAttribute('width');
    el.removeAttribute('height');
  });
    // —— Bước 2.1: xóa hẳn <p> chứa ký tự Arabic (hoặc bất kỳ non-ASCII nào) ——
    ctnDescription.querySelectorAll('p').forEach(p => {
      if (/[^\u0000-\u007F]/.test(p.textContent)) {
        p.remove();
      }
    });
  // 3) Thẻ được phép
  const ALLOWED = ['P','BR','UL','LI','STRONG','B','EM','I'];

  // 4) Unwrap (bóc lõi) mọi thẻ không phải ALLOWED
  //    Giữ text và children, nhưng bỏ thẻ wrapper.
  //    Lưu ý: phải convert NodeList sang Array để tránh live-list issues.
  Array.from(ctnDescription.querySelectorAll('*')).forEach(el => {
    if (!ALLOWED.includes(el.tagName)) {
      const parent = el.parentNode;
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      parent.removeChild(el);
    }
  });

  // 5) Cuối cùng serialize lại HTML5 sạch sẽ
  const parser = new DOMParser();
  const doc    = parser.parseFromString(ctnDescription.innerHTML, 'text/html');
  description  = doc.body.innerHTML.trim();
}



// Ảnh thumbnail chính
if (pdpLeftWrap) {
    const thumbnailImgElements = pdpLeftWrap.querySelectorAll('img'); // Lấy tất cả các thẻ img
    thumbnailImages = Array.from(thumbnailImgElements) // Chuyển đổi NodeList thành Array
        .slice(0, 9) // Giới hạn chỉ lấy 9 ảnh
        .map((imgEl, i) => {
            const src = imgEl?.getAttribute('src'); // Lấy src của ảnh
            const isVideoIcon = imgEl.classList.contains('slider--videoIcon--WNGL6jY'); // Kiểm tra có phải video icon không
            if (!src || isVideoIcon) return null; // Nếu là video icon hoặc không có src thì bỏ qua
            return { url: resizeImageUrl(src), display_order: i }; // Chỉnh sửa URL ảnh nếu cần
        })
        .filter(Boolean); // Loại bỏ các giá trị null hoặc undefined

    // Loại bỏ ảnh trùng lặp
    thumbnailImages = removeDuplicates(thumbnailImages);

    console.log(thumbnailImages); // In ra kết quả để kiểm tra
}


  // Xử lý biến thể
  if (pdprightWrap) {
    // Giữ nguyên logic cũ của AliExpress
    titleProduct = safeText(pdprightWrap.querySelector('[class^="title--wrap"]'));
    // Fallback nếu selector thay đổi
    if (!titleProduct) {
      titleProduct = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || '';
    }
    if (!titleProduct) {
      titleProduct = (document.title || '').trim();
    }
    if (titleProduct.length > 255) titleProduct = titleProduct.slice(0, 255);

    const ctnVariants = pdprightWrap.querySelector('[class^="sku-item--wrap"]');
    if (ctnVariants) {
      const groups = Array.from(ctnVariants.querySelectorAll('[class^="sku-item--property"]')).map(prop => ({
        name: normalize(prop.querySelector('[class^="sku-item--title"] > span')?.childNodes[0]?.textContent || ''),
        items: Array.from(prop.querySelectorAll('[class^="sku-item--skus"] > div')),
        propElem: prop
      }));

      const colorImageMap = {};
      const firstGroup = groups[0];

      const colorResults = firstGroup.items.map(item => {
        const img = item.querySelector('img');
        if (!img) return null;
        const label = normalize(img.getAttribute('alt'));
        const src = img.getAttribute('src');
        return { label, url: modifyImageUrl(src) };
      });

      colorResults.forEach(r => {
        if (r) colorImageMap[r.label] = { url: r.url };
      });

      const combos = cartesian(groups.map(g => g.items));
      console.log('🔢 [ALIEXPRESS] Số tổ hợp variants:', combos.length);

      for (const combo of combos) {
        groups.forEach(g => g.items.forEach(i => i.classList.remove('active')));
        combo.forEach(opt => opt.click());
        await waitTime(50);

        const price = parseFloat(pdprightWrap.querySelector('.product-price')?.textContent.replace(/[^\d.]/g, '')) || null;
        const list_price = 0.00;
        const quantity = parseInt(document.querySelector('[class^="quantity--info"] span')?.textContent.match(/\d+/)?.[0]) || 1;

        const rec = { price: list_price, list_price: 0.00, currency, quantity };
        groups.forEach(({ name, propElem }) => {
          rec[name] = safeText(propElem.querySelector('[class^="sku-item--title"] > span span'));
        });

        const mainLabel = normalize(rec[firstGroup.name]);
        if (mainLabel && colorImageMap[mainLabel]) {
          rec.primary_image = colorImageMap[mainLabel];
        }

        variantsData.push(rec);
      }
    } else {
      // Sản phẩm không có biến thể
      console.log('🔵 [ALIEXPRESS] Không có biến thể');

      const price = parseFloat(pdprightWrap.querySelector('.product-price')?.textContent.replace(/[^\d.]/g, '')) || null;
      const list_price = 0.00;
      const quantity = parseInt(document.querySelector('[class^="quantity--info"] span')?.textContent.match(/\d+/)?.[0]) || 1;

      variantsData.push({ price: list_price, list_price: 0.00, currency, quantity });
      console.log('💵 [ALIEXPRESS] Price:', price, currency);
    }
  }

  console.log('✅ AliExpress Final Data:', {
    title: titleProduct,
    description: description.substring(0, 100) + '...',
    variants: variantsData
  });

  return {
    title: titleProduct,
    description,
    source: "aliexpress",
    thumbnailImg: thumbnailImages,
    variants: variantsData,
  };
}


async function scrapeTemuData() {
  console.log('🛒 === SCRAPING TEMU ===');

  // Đợi một chút để trang load đầy đủ
  await wait(1000);
  console.log('scrapeTemuData (DOM) bắt đầu');

  // 1) Lấy Title
  let title = '';
  // Mở rộng selector để bền vững hơn theo UI mới của Temu
  const titleEl =
    // Ưu tiên class mới Temu: span._25g_jM0z có aria-label
    document.querySelector('span._25g_jM0z[aria-label]') ||
    document.querySelector('h1[aria-label]') ||
    document.querySelector('h1[data-testid="product-title"]') ||
    document.querySelector('.product-title') ||
    document.querySelector('span[aria-label]') ||
    document.querySelector('[data-testid="pdp-title"], [data-test="product-title"]');
  if (titleEl) {
    title = (titleEl.getAttribute('aria-label') || titleEl.textContent || '').trim();
  }
  // Fallback: OG title hoặc document.title
  if (!title) {
    title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || '';
  }
  if (!title) {
    title = (document.title || '').trim();
  }
  if (title.length > 255) title = title.slice(0, 255);
  console.log('. title =', title);

  // 2) Lấy Description
  let description = '';
  const additionalDescriptions = document.querySelectorAll('div._1YBVObhm');
  additionalDescriptions.forEach(el => {
      let materialText = el.innerText.trim();
      if (materialText) {
          description += `<p>${materialText}</p>`;
      }
  });

  const descriptionElements = document.querySelectorAll('div[style="font-size:12px;color:#333333;font-weight:400"]');
  descriptionElements.forEach(element => {
      let descriptionText = element.innerHTML.trim();
      descriptionText = descriptionText.replace(/<img/g, '<img src');
      description += `<p>${descriptionText}</p>`;
  });

  console.log('. Length mô tả =', description.length);

  // 3) Lấy Thumbnails (ảnh đại diện)
  const galleryWrap = document.querySelector('[data-testid="gallery-list"]') || document.querySelector('.swiper-container');
  if (galleryWrap) {
    galleryWrap.scrollLeft = galleryWrap.scrollWidth;
    await wait(200);
  }

  const rawImgs = Array.from(document.querySelectorAll('li[data-index] img, div._3ACovDZO img'));
  let thumbnailImages = Array.from(new Set(rawImgs.map(i => i.src)))
      .filter(u => !!u)
      .slice(0, 9)
      .map((url, i) => ({
          url: modifyImageUrl(url),
          display_order: i
      }));

  thumbnailImages = removeDuplicates(thumbnailImages);
  console.log('. thumbnailImages =', thumbnailImages);

// 4) Helpers: đọc giá hiện tại + chờ giá thay đổi sau khi click
function getPriceAndCurrency() {
  const box =
    document.querySelector('div._1vkz0rgG.PjdWn3s') ||
    document.querySelector('div[class^="_1vkz"]');

  if (!box) {
    console.warn('⚠️ [TEMU] Không tìm thấy price box!');
    return { price: null, currency: null, raw: null };
  }

  // Temu render giá bằng nhiều <span>; nối hết text lại để parse
  const spans = box.querySelectorAll('span');

  const raw = Array.from(spans)
    .map(s => (s.textContent || '').trim())
    .join('')
    .replace(/\s+/g, '');

  // Tách currency và số (ví dụ "$13.79" hoặc "₫123.456")
  const m = raw.match(/([^\d.,]?)(\d[\d.,]*)/);

  let currency = null, price = null;
  if (m) {
    currency = m[1] || null;
    // Chuẩn hoá về dấu chấm thập phân
    const num = m[2].replace(/,/g, '.');
    price = parseFloat(num);
  }

  return { price, currency, raw };
}

async function waitForPriceUpdate(prevRaw, tries = 15, sleep = 120) {
  // Chờ đến khi text trong price box khác trước đó (DOM đã cập nhật)
  for (let i = 0; i < tries; i++) {
    await wait(sleep);
    const { raw } = getPriceAndCurrency();

    if (raw && raw !== prevRaw) {
      console.log(`✅ [TEMU] Giá thay đổi: ${prevRaw} → ${raw}`);
      return raw;
    }
  }
  console.warn(`⚠️ [TEMU] Giá không đổi sau ${tries * sleep}ms`);
  return prevRaw; // fallback nếu không đổi
}

// 5) Lấy danh sách nút Color/Size
const colorButtons = document.querySelectorAll(
  'div._20PH8eAG > div[role="button"][aria-label]'
);
const sizeButtons = document.querySelectorAll(
  'div._2ZDZJTUw > div[role="button"]'
);

// Hàm lấy ảnh preview từ nút color (nếu có)
function getColorImageUrl(btn) {
  let url = null;
  const picDiv = btn.querySelector('div[class]');

  if (picDiv) {
    const bg = getComputedStyle(picDiv).backgroundImage;
    if (bg && bg !== 'none') {
      url = bg.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    }
  }

  if (!url) {
    const img = btn.querySelector('img');
    if (img) url = img.src;
  }

  return url ? modifyImageUrl(url) : null;
}

// 6) Lặp qua từng color/size, click & đọc giá sau mỗi lần
let variants = [];

console.log('🎨 [TEMU] Số nút Color:', colorButtons.length);
console.log('📏 [TEMU] Số nút Size:', sizeButtons.length);

if (colorButtons.length) {
  for (const cBtn of colorButtons) {
    if (cBtn.getAttribute('aria-disabled') === 'true') continue;

    cBtn.scrollIntoView({ block: 'center' });
    const beforeColor = getPriceAndCurrency().raw;
    cBtn.click();
    await waitForPriceUpdate(beforeColor);

    const colorName = (cBtn.getAttribute('aria-label') || 'Unknown Color').trim();
    const colorImg = getColorImageUrl(cBtn);

    if (sizeButtons.length) {
      for (const sBtn of sizeButtons) {
        if (sBtn.getAttribute('aria-disabled') === 'true') continue;

        sBtn.scrollIntoView({ block: 'center' });
        const beforeSize = getPriceAndCurrency().raw;
        sBtn.click();
        await waitForPriceUpdate(beforeSize);

        const { price, currency } = getPriceAndCurrency();
        console.log(`💵 [TEMU] Variant: ${colorName} / ${(sBtn.textContent || '').trim()} = ${price} ${currency}`);

        variants.push({
          price,
          list_price: 0.0,
          currency,
          quantity: 100,
          color: colorName,
          size: (sBtn.textContent || 'Unknown Size').trim(),
          ...(colorImg && { primary_image: { url: colorImg } })
        });
      }
    } else {
      const { price, currency } = getPriceAndCurrency();
      console.log(`💵 [TEMU] Variant: ${colorName} = ${price} ${currency}`);

      variants.push({
        price,
        list_price: 0.0,
        currency,
        quantity: 100,
        color: colorName,
        ...(colorImg && { primary_image: { url: colorImg } })
      });
    }
  }
} else if (sizeButtons.length) {
  console.log('📏 [TEMU] Chỉ có Size, không có Color');

  // Trường hợp chỉ có Size, không có Color
  for (const sBtn of sizeButtons) {
    if (sBtn.getAttribute('aria-disabled') === 'true') continue;

    sBtn.scrollIntoView({ block: 'center' });
    const beforeSize = getPriceAndCurrency().raw;
    sBtn.click();
    await waitForPriceUpdate(beforeSize);

    const { price, currency } = getPriceAndCurrency();
    console.log(`💵 [TEMU] Variant: ${(sBtn.textContent || '').trim()} = ${price} ${currency}`);

    variants.push({
      price,
      list_price: 0.0,
      currency,
      quantity: 100,
      size: (sBtn.textContent || 'Unknown Size').trim()
    });
  }
} else {
  console.log('🔵 [TEMU] Không có biến thể, lấy giá trực tiếp');

  // Không có biến thể
  const { price, currency } = getPriceAndCurrency();
  console.log('💵 [TEMU] Single product price:', price, currency);

  if (price == null) throw new Error('Không lấy được giá sản phẩm (price=null)');
  variants.push({
    price,
    list_price: 0.0,
    currency,
    quantity: 1
  });
}

console.log('✅ [TEMU] Total variants collected:', variants.length);



  const result = {
    title,
    description,
    source: 'temu',
    thumbnailImg: thumbnailImages,
    variants
  };
  console.log('✅ scrapeTemuData (DOM) trả về:', result);
  return result;
}


async function scrapeEtsyData() {
  console.log('🛒 === SCRAPING ETSY ===');

  // Đợi trang load đầy đủ
  await wait(2000);
  console.log('scrapeEtsyData bắt đầu');

  // 1) Lấy Title
  let title = '';
  const titleEl = document.querySelector('h1[class*="wt-text-body"]') ||
                  document.querySelector('h1');
  if (titleEl) {
    title = titleEl.textContent.trim();
  }
  if (!title) {
    title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || '';
  }
  if (!title) {
    title = (document.title || '').trim();
  }
  if (title.length > 255) title = title.slice(0, 255);
  console.log('📝 Title =', title);

  // 2) Lấy Description từ phần product details
  let description = '';
  const descriptionContainer = document.querySelector('[data-id="description-text"]') ||
                               document.querySelector('[class*="wt-content-toggle_body"]');
  if (descriptionContainer) {
    // Clone để không ảnh hưởng DOM gốc
    const clone = descriptionContainer.cloneNode(true);

    // Xóa các thẻ không mong muốn
    clone.querySelectorAll('img, table, thead, tbody, tr, th, td, iframe, script, video').forEach(el => el.remove());

    // Xóa attributes
    clone.querySelectorAll('*').forEach(el => {
      el.removeAttribute('style');
      el.removeAttribute('class');
      el.removeAttribute('align');
      el.removeAttribute('width');
      el.removeAttribute('height');
    });

    // Chỉ giữ các thẻ cho phép
    const ALLOWED = ['P','BR','UL','LI','STRONG','B','EM','I','H1','H2','H3'];
    Array.from(clone.querySelectorAll('*')).forEach(el => {
      if (!ALLOWED.includes(el.tagName)) {
        const parent = el.parentNode;
        while (el.firstChild) {
          parent.insertBefore(el.firstChild, el);
        }
        parent.removeChild(el);
      }
    });

    description = clone.innerHTML.trim();
  }
  console.log('📄 Description length =', description.length);

  // 3) Lấy Thumbnails từ carousel
  let thumbnailImages = [];

  // Scroll window để load lazy images
  window.scrollTo(0, 0);
  await wait(500);
  window.scrollTo(0, 300);
  await wait(500);

  // Tìm tất cả li trong carousel (kể cả display:none)
  const allCarouselLi = document.querySelectorAll('ul[class*="carousel-pane-list"] li');
  console.log('Total carousel LI elements:', allCarouselLi.length);

  const seenImageIds = new Set();
  const seenUrls = new Set();

  allCarouselLi.forEach((li, index) => {
    const imageId = li.getAttribute('data-image-id');

    // Bỏ qua nếu không có image-id hoặc đã xử lý
    if (!imageId || seenImageIds.has(imageId)) return;

    seenImageIds.add(imageId);

    // Tìm img tag
    const img = li.querySelector('img');
    if (!img) {
      console.log(`LI ${index}: No img found`);
      return;
    }

    let bestUrl = null;

    // 1. Ưu tiên: Lấy từ srcset (chất lượng cao nhất)
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      // srcset format: "url1 1x, url2 2x" hoặc "url1, url2"
      const urls = srcset.split(',').map(s => {
        const parts = s.trim().split(' ');
        return parts[0]; // Lấy URL, bỏ descriptor (1x, 2x)
      });

      // Lấy URL có chất lượng cao nhất (thường là URL cuối cùng)
      bestUrl = urls[urls.length - 1];
      console.log(`LI ${index}: Found in srcset:`, bestUrl);
    }

    // 2. Fallback: Lấy từ src
    if (!bestUrl || bestUrl.includes('placeholder') || bestUrl.includes('data:image')) {
      bestUrl = img.src || img.getAttribute('data-src');
      console.log(`LI ${index}: Using src:`, bestUrl);
    }

    // 3. Fallback: Tìm trong data-src-zoom-image (full resolution)
    if (!bestUrl || bestUrl.includes('placeholder')) {
      const zoomSrc = li.getAttribute('data-src-zoom-image');
      if (zoomSrc) {
        bestUrl = zoomSrc;
        console.log(`LI ${index}: Using zoom image:`, bestUrl);
      }
    }

    // Validate và thêm vào list
    if (bestUrl &&
        !bestUrl.includes('placeholder') &&
        !bestUrl.includes('data:image') &&
        bestUrl.startsWith('http') &&
        !seenUrls.has(bestUrl)) {

      seenUrls.add(bestUrl);

      // Upgrade URL sang resolution cao nhất
      bestUrl = bestUrl
        .replace(/\/il_\d+xN\./g, '/il_1140xN.')
        .replace(/\/il_\d+x\d+\./g, '/il_1140xN.')
        .replace(/_\d+x\d+\./g, '_1140x1140.')
        .replace(/\d+x\d+\.jpg/g, '1140x1140.jpg');

      thumbnailImages.push({
        url: bestUrl,
        display_order: thumbnailImages.length
      });

      console.log(`✓ Image ${thumbnailImages.length}: ${bestUrl}`);

      // Giới hạn 9 ảnh
      if (thumbnailImages.length >= 9) return;
    }
  });

  // Fallback cuối cùng nếu vẫn không có ảnh
  if (thumbnailImages.length === 0) {
    console.log('Fallback: tìm tất cả img có data-image-id');
    const fallbackImages = document.querySelectorAll('img[data-image-id]');
    fallbackImages.forEach((img, i) => {
      if (i < 9) {
        let url = img.src || img.getAttribute('data-src');
        if (url && !url.includes('placeholder')) {
          url = url.replace(/\/il_\d+xN\./g, '/il_1140xN.');
          thumbnailImages.push({ url, display_order: i });
        }
      }
    });
  }

  thumbnailImages = removeDuplicates(thumbnailImages);
  console.log('✅ Total thumbnail images collected:', thumbnailImages.length, thumbnailImages);

  // 4) Lấy giá và currency
  function getPriceAndCurrency() {
    // Danh sách các selector để thử (theo thứ tự ưu tiên)
    const selectors = [
      // 1. P tag chứa giá (chính xác nhất)
      'p[class*="wt-text-title-larger"]',
      // 2. Screen reader text (fallback)
      'p[class*="wt-text-title-larger"] span[class*="wt-screen-reader-only"]',
      // 3. Buy box region
      '[data-buy-box-region="price"]',
      // 4. Các selector khác
      'p.wt-text-title-03',
      'div[data-selector="price-only"] p',
      'div[data-buy-box-region="price"] p',
      // 5. Meta tag OG price
      'meta[property="product:price:amount"]'
    ];

    let priceEl = null;
    let text = '';

    // Thử từng selector
    for (const selector of selectors) {
      priceEl = document.querySelector(selector);
      if (priceEl) {
        if (selector.includes('meta')) {
          text = priceEl.getAttribute('content') || '';
        } else {
          // Lấy textContent và loại bỏ text từ span.wt-screen-reader-only
          const clone = priceEl.cloneNode(true);
          const screenReaderSpan = clone.querySelector('span[class*="wt-screen-reader-only"]');
          if (screenReaderSpan) {
            screenReaderSpan.remove();
          }
          text = clone.textContent.trim();
        }

        // Kiểm tra text có chứa số không (tránh lấy nhầm label "Price:")
        if (/\d/.test(text)) {
          console.log(`✓ [ETSY] Found price with selector: ${selector}`);
          console.log(`  Text: "${text}"`);
          break;
        } else {
          console.log(`✗ [ETSY] Selector "${selector}" found but no digits: "${text}"`);
          priceEl = null; // Reset để thử selector tiếp theo
        }
      }
    }

    if (!priceEl || !text) {
      console.warn('❌ [ETSY] Price element not found with any selector!');
      console.log('Available price-related elements:');
      document.querySelectorAll('[class*="price"], [data-buy-box-region="price"]').forEach(el => {
        console.log('  -', el.tagName, el.className, ':', el.textContent.substring(0, 50));
      });
      return { price: null, currency: null };
    }

    console.log(`  Cleaned text: "${text}"`);

    // Parse giá - Etsy có nhiều format:
    // "₫743,526" hoặc "$25.99" hoặc "25.99 €" hoặc "613,357₫"

    // Pattern 1: Currency symbol trước số (₫743,526 hoặc $25.99)
    let match = text.match(/^([^\d\s.,]+)\s*([\d.,]+)/);
    if (match) {
      const currency = match[1].trim();
      let priceStr = match[2];

      // Xử lý format số theo locale
      if (priceStr.includes(',') && !priceStr.includes('.')) {
        priceStr = priceStr.replace(/\./g, '').replace(',', '.');
      } else {
        priceStr = priceStr.replace(/,/g, '');
      }

      const price = parseFloat(priceStr);
      console.log(`✅ [ETSY] Parsed: ${price} ${currency}`);
      return { price: isNaN(price) ? null : price, currency };
    }

    // Pattern 2: Số trước, currency sau (25.99 € hoặc 613,357₫)
    match = text.match(/^([\d.,]+)\s*([^\d\s.,]+)/);
    if (match) {
      let priceStr = match[1];
      const currency = match[2].trim();

      if (priceStr.includes(',') && !priceStr.includes('.')) {
        priceStr = priceStr.replace(/\./g, '').replace(',', '.');
      } else {
        priceStr = priceStr.replace(/,/g, '');
      }

      const price = parseFloat(priceStr);
      console.log(`✅ [ETSY] Parsed: ${price} ${currency}`);
      return { price: isNaN(price) ? null : price, currency };
    }

    // Fallback: chỉ có số
    const numMatch = text.match(/([\d.,]+)/);
    if (numMatch) {
      let priceStr = numMatch[1].replace(/,/g, '');
      const price = parseFloat(priceStr);
      console.log(`✅ [ETSY] Parsed (no currency): ${price}`);
      return { price: isNaN(price) ? null : price, currency: '$' };
    }

    console.warn('❌ [ETSY] Cannot parse price from text:', text);
    return { price: null, currency: null };
  }

  // 5) Hàm đợi giá thay đổi sau khi select variation
  async function waitForPriceChange(previousPrice, maxAttempts = 25, delayMs = 200) {
    let lastPrice = previousPrice;
    let stableCount = 0;

    for (let i = 0; i < maxAttempts; i++) {
      await wait(delayMs);
      const { price } = getPriceAndCurrency();

      // Nếu giá đã thay đổi so với ban đầu
      if (price !== null && Math.abs(price - previousPrice) > 0.01) {
        // Kiểm tra giá có ổn định không (giống nhau 2 lần liên tiếp)
        if (Math.abs(price - lastPrice) < 0.01) {
          stableCount++;

          if (stableCount >= 2) {
            console.log(`✅ [ETSY] Price changed: ${previousPrice} → ${price}`);
            return price;
          }
        } else {
          stableCount = 0;
        }
        lastPrice = price;
      }
    }

    console.warn(`⚠ [ETSY] Timeout after ${maxAttempts * delayMs}ms`);
    const finalPrice = getPriceAndCurrency().price;
    return finalPrice;
  }

  // 6) Lấy các variation selectors
  const variationSelects = document.querySelectorAll('select[id^="variation-selector-"]');
  let variants = [];

  console.log('🔍 [ETSY] Variation selects found:', variationSelects.length);
  console.log('📋 [ETSY] Select elements:', variationSelects);

  if (variationSelects.length > 0) {
    // Có biến thể - Lấy giá theo lựa chọn hiện tại của user
    console.log('📦 [ETSY] Product has variations, processing...');

    const variationGroups = Array.from(variationSelects).map(select => {
      // Lấy label từ aria-labelledby
      const labelId = select.getAttribute('aria-labelledby');
      let label = 'Variation';
      if (labelId) {
        const labelEl = document.getElementById(labelId);
        if (labelEl) {
          label = labelEl.textContent.trim().replace(':', '');
        }
      }

      // Fallback: tìm label gần select
      if (label === 'Variation') {
        const labelEl = select.closest('[class*="wt-mb-xs"]')?.querySelector('label');
        if (labelEl) {
          label = labelEl.textContent.trim().replace(':', '');
        }
      }

      console.log('  📝 Variation group:', label);
      return { label, select };
    });

    // Lấy tất cả options của tất cả selects
    const allCombos = [];

    // Duyệt qua từng select để lấy tất cả options
    const optionsList = variationGroups.map(g => {
      const options = Array.from(g.select.querySelectorAll('option'))
        .filter(opt => opt.value && opt.value !== '' && !opt.disabled);
      console.log(`   📋 [ETSY] "${g.label}": ${options.length} options`);

      return options;
    });

    // Tạo tất cả combinations
    const combos = cartesian(optionsList);
    console.log(`� [ETSY] Total combinations: ${combos.length}`);

    // Giới hạn số lượng nếu quá nhiều
    const maxCombos = 50;
    if (combos.length > maxCombos) {
      console.warn(`⚠️ [ETSY] Too many combinations (${combos.length}), limiting to ${maxCombos}`);
      combos.length = maxCombos;
    }

    // Lặp qua từng combination
    for (let i = 0; i < combos.length; i++) {
      const combo = combos[i];

      let price = 0;
      let currency = '$';

      // ƯU TIÊN 1: Thử lấy giá từ TEXT OPTION trước (vd: "Orange drum & name (721,661₫)")
      for (const option of combo) {
        const text = option.textContent.trim();
        const priceMatch = text.match(/\(([\d.,]+)([^\d\s.,]+)\)/); // Match (721,661₫)
        if (priceMatch) {
          let priceStr = priceMatch[1];
          currency = priceMatch[2];

          // Convert format Vietnamese: 721,661 → 721.661
          if (priceStr.includes(',') && !priceStr.includes('.')) {
            priceStr = priceStr.replace(/\./g, '').replace(',', '.');
          } else {
            priceStr = priceStr.replace(/,/g, '');
          }

          price = parseFloat(priceStr);
          console.log(`💡 [ETSY] Extracted price from option text: ${price} ${currency}`);
          break;
        }
      }

      // FALLBACK 2: Nếu không có giá trong option text, thử select và lấy từ DOM
      if (!price || price === 0) {
        // Select TẤT CẢ options
        for (let idx = 0; idx < combo.length; idx++) {
          const option = combo[idx];
          const select = variationGroups[idx].select;

          try {
            select.value = option.value;
            option.selected = true;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(200);
          } catch (e) {
            console.error(`❌ [ETSY] Error selecting:`, e);
          }
        }

        // Đợi DOM update
        await wait(800);

        // LẤY GIÁ từ DOM
        const priceData = getPriceAndCurrency();
        price = priceData.price;
        currency = priceData.currency;
      }

      const variant = {
        price: price || 0,
        list_price: 0.00,
        currency: currency || '$',
        quantity: 100
      };

      // Thêm tên các variation
      combo.forEach((option, idx) => {
        const varName = variationGroups[idx].label.toLowerCase().replace(/\s+/g, '_');
        variant[varName] = option.textContent.trim();
      });

      console.log(`💵 [ETSY] Variant [${i + 1}/${combos.length}]:`, variant);
      variants.push(variant);
    }

    console.log(`✅ [ETSY] Collected ${variants.length} variants total`);
  } else {
    // Không có biến thể
    console.log('🔵 [ETSY] No variations found, single product');
    const { price, currency } = getPriceAndCurrency();

    if (!price) {
      console.error('❌ [ETSY] Cannot get price!');
    }

    console.log(`💵 [ETSY] Price: ${price} ${currency}`);

    variants.push({
      price: price || 0,
      list_price: 0.00,
      currency: currency || '$',
      quantity: 100
    });
  }

  console.log('✅ [ETSY] Final variants:', variants);

  const result = {
    title,
    description,
    source: 'etsy',
    thumbnailImg: thumbnailImages,
    variants
  };
  console.log('✅ [ETSY] scrapeEtsyData result:', result);
  return result;
}








async function scrapeAmazonData() {
  console.log('🛒 === SCRAPING AMAZON ===');

  // Đợi trang load đầy đủ
  await wait(2000);
  console.log('scrapeAmazonData bắt đầu');

  // 1) Lấy Title từ #titleSection > #productTitle
  let title = '';
  const titleEl = document.querySelector('#titleSection #productTitle') ||
                  document.querySelector('#productTitle') ||
                  document.querySelector('h1 span#productTitle');
  if (titleEl) {
    title = titleEl.textContent.trim();
  }
  if (!title) {
    title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || '';
  }
  if (!title) {
    title = (document.title || '').split(' : Amazon')[0].trim();
  }
  if (title.length > 255) title = title.slice(0, 255);
  console.log('📝 [AMAZON] Title =', title);

  // 2) Hàm lấy giá và currency
  function getAmazonPriceAndCurrency() {
    let priceText = '';
    let currency = '$';

    // Lấy từ .a-price .a-offscreen
    const offscreenPrice = document.querySelector('.a-price.reinventPricePriceToPayMargin .a-offscreen') ||
                           document.querySelector('.a-price.priceToPay .a-offscreen') ||
                           document.querySelector('#corePrice_feature_div .a-offscreen') ||
                           document.querySelector('#corePriceDisplay_desktop_feature_div .a-offscreen') ||
                           document.querySelector('#apex_desktop .a-offscreen') ||
                           document.querySelector('.a-price .a-offscreen');

    if (offscreenPrice) {
      priceText = offscreenPrice.textContent.trim();
    }

    // Fallback: Lấy từ các span riêng lẻ
    if (!priceText) {
      const priceContainer = document.querySelector('.a-price.reinventPricePriceToPayMargin') ||
                             document.querySelector('.a-price.priceToPay') ||
                             document.querySelector('#corePrice_feature_div .a-price') ||
                             document.querySelector('.a-price');

      if (priceContainer) {
        const symbol = priceContainer.querySelector('.a-price-symbol')?.textContent || '$';
        const whole = priceContainer.querySelector('.a-price-whole')?.textContent?.replace(/[.,]$/, '') || '0';
        const fraction = priceContainer.querySelector('.a-price-fraction')?.textContent || '00';

        currency = symbol;
        priceText = `${symbol}${whole}.${fraction}`;
      }
    }

    if (!priceText) {
      return { price: null, currency: null, raw: null };
    }

    // Parse price
    let price = null;
    const currencyMatch = priceText.match(/([^\d\s.,]+)/);
    if (currencyMatch) {
      currency = currencyMatch[1].trim();
    }

    const priceMatch = priceText.match(/[\d.,]+/);
    if (priceMatch) {
      let priceStr = priceMatch[0];
      if (priceStr.includes(',') && priceStr.includes('.')) {
        if (priceStr.lastIndexOf(',') > priceStr.lastIndexOf('.')) {
          priceStr = priceStr.replace(/\./g, '').replace(',', '.');
        } else {
          priceStr = priceStr.replace(/,/g, '');
        }
      } else if (priceStr.includes(',')) {
        const parts = priceStr.split(',');
        if (parts[parts.length - 1].length === 2) {
          priceStr = priceStr.replace(',', '.');
        } else {
          priceStr = priceStr.replace(/,/g, '');
        }
      }
      price = parseFloat(priceStr);
    }

    return { price: isNaN(price) ? null : price, currency, raw: priceText };
  }

  // Hàm đợi giá thay đổi sau khi click
  async function waitForPriceUpdate(prevRaw, tries = 20, sleep = 150) {
    for (let i = 0; i < tries; i++) {
      await wait(sleep);
      const { raw } = getAmazonPriceAndCurrency();
      if (raw && raw !== prevRaw) {
        console.log(`✅ [AMAZON] Giá thay đổi: ${prevRaw} → ${raw}`);
        return raw;
      }
    }
    return prevRaw;
  }

  // 3) Lấy Description - CHỈ LẤY BULLET POINTS TỪ "About this item"
  let description = '';

  const bulletList = document.querySelector('#feature-bullets ul.a-unordered-list') ||
                     document.querySelector('ul.a-unordered-list.a-vertical.a-spacing-small');
  if (bulletList) {
    const bullets = Array.from(bulletList.querySelectorAll('li span.a-list-item'))
      .map(span => span.textContent.trim())
      .filter(t => t && !t.includes('›') && t.length > 5);

    if (bullets.length > 0) {
      description = '<ul>' + bullets.map(b => `<li>${b}</li>`).join('') + '</ul>';
    }
    console.log('📄 [AMAZON] Bullets found:', bullets.length);
  }

  // KHÔNG lấy thêm productDescription hoặc aplus vì thường chứa quá nhiều nội dung/ảnh không cần thiết
  console.log('📄 [AMAZON] Description length =', description.length);

  // 4) Lấy Thumbnails
  let thumbnailImages = [];
  const seenUrls = new Set();

  // Hàm kiểm tra URL có phải ảnh 360/video/icon không
  function isInvalidImageUrl(url) {
    if (!url) return true;
    const lowerUrl = url.toLowerCase();
    // Loại bỏ các ảnh 360 spin, video, icon
    return lowerUrl.includes('360') ||
           lowerUrl.includes('spin') ||
           lowerUrl.includes('video') ||
           lowerUrl.includes('play-button') ||
           lowerUrl.includes('play_icon') ||
           lowerUrl.includes('icon') ||
           lowerUrl.includes('sprite') ||
           lowerUrl.includes('transparent-pixel') ||
           lowerUrl.includes('grey-pixel');
  }

  const mainImg = document.querySelector('#landingImage') ||
                  document.querySelector('img#imgBlkFront');

  if (mainImg) {
    const dynamicImageAttr = mainImg.getAttribute('data-a-dynamic-image');
    if (dynamicImageAttr) {
      try {
        const imgObj = JSON.parse(dynamicImageAttr);
        const urls = Object.keys(imgObj);

        urls.forEach(url => {
          if (isInvalidImageUrl(url)) return; // Bỏ qua ảnh 360/video
          if (!seenUrls.has(url) && thumbnailImages.length < 9) {
            const hiresUrl = url.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.');
            if (!seenUrls.has(hiresUrl) && !isInvalidImageUrl(hiresUrl)) {
              seenUrls.add(hiresUrl);
              thumbnailImages.push({ url: hiresUrl, display_order: thumbnailImages.length });
            }
          }
        });
      } catch (e) {
        console.warn('Cannot parse dynamic image JSON');
      }
    }
  }

  const thumbGallery = document.querySelector('#altImages') || document.querySelector('#imageBlock');
  if (thumbGallery) {
    const allThumbImages = thumbGallery.querySelectorAll('li img');

    allThumbImages.forEach((img) => {
      if (thumbnailImages.length >= 9) return;
      const parentLi = img.closest('li');

      // Bỏ qua video thumbnails
      if (parentLi?.classList.contains('videoThumbnail')) return;
      if (parentLi?.classList.contains('360Icons')) return;
      if (parentLi?.classList.contains('spinIcon')) return;

      let src = img.getAttribute('src') || '';
      if (!src) return;

      // Bỏ qua ảnh 360/video/icon
      if (isInvalidImageUrl(src)) return;

      // Kiểm tra alt text có phải 360 không
      const alt = (img.getAttribute('alt') || '').toLowerCase();
      if (alt.includes('360') || alt.includes('spin') || alt.includes('video')) return;

      src = src.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.');

      if (!seenUrls.has(src)) {
        seenUrls.add(src);
        thumbnailImages.push({ url: src, display_order: thumbnailImages.length });
      }
    });
  }

  thumbnailImages = removeDuplicates(thumbnailImages);
  console.log('🖼️ [AMAZON] Total thumbnail images:', thumbnailImages.length);

  // 5) XỬ LÝ VARIANTS - TÁCH RIÊNG TỪNG LOẠI VARIATION
  let variants = [];

  // DEBUG: Log tất cả các div có id chứa "variation" để tìm đúng selector
  console.log('========== DEBUG: FINDING VARIATION CONTAINERS ==========');
  const allVariationDivs = document.querySelectorAll('[id*="variation"], [id*="twister"], [id*="swatch"]');
  console.log('📦 Found elements with variation/twister/swatch in ID:', allVariationDivs.length);
  allVariationDivs.forEach((el, i) => {
    console.log(`   [${i}] ID="${el.id}", class="${el.className?.substring(0, 50)}"`);
  });

  // Debug: Tìm tất cả swatches - MỞ RỘNG SELECTOR
  const allSwatchLis = document.querySelectorAll('li[data-defaultasin], li.swatch-list-item-original, li.swatchSelect, li.swatchAvailable, li[id*="color"], li[id*="size"], .imageSwatches li, #twister li, #twister_feature_div li');
  console.log('🎯 All swatch LIs found:', allSwatchLis.length);
  allSwatchLis.forEach((li, i) => {
    const parent = li.closest('[id]');
    const img = li.querySelector('img');
    const price = li.querySelector('span[class*="price"], .a-price, .a-color-price')?.textContent?.trim();
    console.log(`   LI[${i}]: parent="${parent?.id}", title="${li.getAttribute('title')?.substring(0, 40)}", hasImg=${!!img}, price="${price || 'N/A'}", classes="${li.className?.substring(0,50)}"`);
  });

  // Debug: Tìm tất cả images trong vùng variation
  const allVariationImgs = document.querySelectorAll('#twister img, #twister_feature_div img, [id*="variation"] img, .imageSwatches img');
  console.log('🖼️ All variation images found:', allVariationImgs.length);
  allVariationImgs.forEach((img, i) => {
    const li = img.closest('li');
    const parentId = img.closest('[id]')?.id;
    console.log(`   IMG[${i}]: src="${img.src?.substring(0, 60)}...", alt="${img.alt?.substring(0, 30)}", parent="${parentId}"`);
  });

  // Debug: Tìm vùng twister_feature_div
  const twisterDiv = document.querySelector('#twister_feature_div') || document.querySelector('#twister');
  if (twisterDiv) {
    console.log('🔧 Twister div found! innerHTML preview:', twisterDiv.innerHTML?.substring(0, 1000));
    // Log tất cả UL trong twister
    const allULs = twisterDiv.querySelectorAll('ul');
    console.log(`   Found ${allULs.length} ULs in twister`);
    allULs.forEach((ul, i) => {
      const lis = ul.querySelectorAll('li');
      console.log(`   UL[${i}]: ${lis.length} LIs, first LI class="${lis[0]?.className?.substring(0,50)}"`);
    });
  }

  // THÊM DEBUG: Tìm tất cả elements liên quan đến variation
  console.log('========== EXTRA DEBUG: VARIATION ELEMENTS ==========');

  // Tìm tất cả elements có "color" trong id hoặc class
  const colorRelated = document.querySelectorAll('[id*="olor"], [class*="olor"], [id*="Color"], [class*="Color"]');
  console.log(`🎨 Color-related elements: ${colorRelated.length}`);
  colorRelated.forEach((el, i) => {
    if (i < 10) { // Chỉ log 10 đầu
      console.log(`   [${i}] tag=${el.tagName}, id="${el.id?.substring(0,30)}", class="${el.className?.substring(0,50)}"`);
    }
  });

  // Tìm row chứa text "Color:"
  const allDivs = document.querySelectorAll('#rightCol div, #centerCol div');
  let colorRowFound = false;
  for (const div of allDivs) {
    const directText = Array.from(div.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE || n.tagName === 'SPAN' || n.tagName === 'LABEL')
      .map(n => n.textContent?.trim())
      .join(' ');
    if (directText.toLowerCase().includes('color:') || directText.toLowerCase().includes('color :')) {
      console.log('🎨 Found Color row! Tag:', div.tagName, 'ID:', div.id, 'Classes:', div.className?.substring(0, 50));
      console.log('   Children count:', div.children.length);
      Array.from(div.children).slice(0, 5).forEach((child, i) => {
        console.log(`   Child[${i}]: tag=${child.tagName}, id="${child.id}", class="${child.className?.substring(0,40)}"`);
      });
      // Tìm img trong div này hoặc siblings
      const imgs = div.querySelectorAll('img');
      console.log(`   Images in this row: ${imgs.length}`);
      if (!colorRowFound && div.parentElement) {
        const siblingImgs = div.parentElement.querySelectorAll('img');
        console.log(`   Images in parent: ${siblingImgs.length}`);
      }
      colorRowFound = true;
      if (colorRowFound) break; // Chỉ log row đầu tiên
    }
  }

  // Hàm lấy tất cả variation types từ trang - CẢI TIẾN V2
  function getVariationButtons(containerId) {
    const buttons = [];

    // HELPER: Kiểm tra tên có phải icon/badge không
    function isInvalidVariantName(name) {
      if (!name) return true;
      const lowerName = name.toLowerCase();
      // Bỏ qua các icon/logo Amazon
      const invalidKeywords = [
        'leaf', 'certified', 'sustainability', 'climate', 'pledge',
        'friendly', 'badge', 'icon', 'logo', 'seal', 'eco',
        'green', 'recycle', 'organic', 'natural', 'sustainable',
        'see available', 'see options', 'featured', 'no featured'
      ];
      return invalidKeywords.some(keyword => lowerName.includes(keyword));
    }

    // HELPER: Kiểm tra URL ảnh có phải icon không
    function isInvalidImageUrl(url) {
      if (!url) return false;
      const lowerUrl = url.toLowerCase();
      const invalidKeywords = [
        'icon', 'badge', 'seal', 'logo', 'certified', 'leaf',
        'sustainability', 'sprite', 'transparent', 'grey-pixel'
      ];
      return invalidKeywords.some(keyword => lowerUrl.includes(keyword));
    }

    // Thử nhiều cách tìm container - mở rộng selectors
    let container = document.querySelector(`#variation_${containerId}`);

    // Thử các ID khác của Amazon
    if (!container) {
      container = document.querySelector(`#twister_feature_div #variation_${containerId}`);
    }

    // Tìm theo ID chứa tên variation (Amazon có nhiều format ID khác nhau)
    if (!container) {
      const possibleIds = [
        `variation_${containerId}`,
        `twister_feature_div`,
        `variation-${containerId}`,
        `${containerId}_row`,
      ];
      for (const id of possibleIds) {
        container = document.getElementById(id);
        if (container) break;
      }
    }

    // Tìm theo label text - CẢI TIẾN
    if (!container) {
      const allLabels = document.querySelectorAll('.a-form-label, .a-row.a-spacing-small label, label.a-form-label, span.a-form-label, div.a-row label');
      for (const label of allLabels) {
        const labelText = (label.textContent || '').toLowerCase();
        if (containerId === 'color_name' && labelText.includes('color')) {
          // Tìm container parent chứa các swatches
          const parent = label.closest('.a-section') || label.closest('.a-row') || label.closest('div[id*="variation"]');
          container = parent?.querySelector('ul') || parent;
          if (container) {
            console.log(`🔍 [LABEL] Found color container via label:`, label.textContent.substring(0, 30));
            break;
          }
        }
        if (containerId === 'size_name' && labelText.includes('size')) {
          const parent = label.closest('.a-section') || label.closest('.a-row') || label.closest('div[id*="variation"]');
          container = parent?.querySelector('ul') || parent;
          if (container) {
            console.log(`🔍 [LABEL] Found size container via label:`, label.textContent.substring(0, 30));
            break;
          }
        }
        if (containerId === 'style_name' && labelText.includes('style')) {
          const parent = label.closest('.a-section') || label.closest('.a-row') || label.closest('div[id*="variation"]');
          container = parent?.querySelector('ul') || parent;
          if (container) {
            console.log(`🔍 [LABEL] Found style container via label:`, label.textContent.substring(0, 30));
            break;
          }
        }
      }
    }

    console.log(`🔍 [DEBUG] Looking for #variation_${containerId}:`, container ? 'FOUND' : 'NOT FOUND');

    // FALLBACK TOÀN CỤC - Tìm tất cả swatches có thể click
    if (!container || buttons.length === 0) {
      console.log(`🔍 [FALLBACK GLOBAL] Searching for any clickable swatches for ${containerId}...`);

      // Các selectors chung cho Amazon swatches
      const globalSelectors = [
        // Twister image swatches (Color)
        '#twister li[data-defaultasin] img',
        '#twister li.swatchAvailable img',
        '#variation_color_name li img',
        '.twisterImages li img',
        'ul.swatches li img',
        '#imageBlock li.swatchSelect img',
        // Swatches với hình
        '[id*="variation"] li[data-defaultasin] img',
        '[id*="twister"] li img',
        // Text swatches (Size)
        '#variation_size_name li',
        '#variation_size_name button',
        '#variation_style_name li',
        '#variation_style_name button',
        // Native select dropdown (fallback)
        '#native_dropdown_selected_color_name',
        '#native_dropdown_selected_size_name',
      ];

      // Nếu tìm Color
      if (containerId === 'color_name') {
        // ULTIMATE FALLBACK: Tìm bất kỳ row nào có label "Color"
        console.log('🔍 [ULTIMATE FALLBACK] Searching for any Color row...');

        // Fallback mới: Tìm tất cả swatches có giá (price under thumbnail - Amazon new design)
        const swatchesWithPrice = document.querySelectorAll('#twister li, #twister_feature_div li, [class*="swatch"] li, [id*="variation"] li, .imageSwatches li');
        console.log(`🔍 [PRICE SWATCH] Checking ${swatchesWithPrice.length} potential swatches with prices...`);

        // Đầu tiên, thử click từng swatch và đọc tên màu từ label hiển thị
        // Amazon hiển thị tên màu trong span#inline-twister-expanded-dimension-text-color_name
        const colorLabelEl = document.querySelector('#inline-twister-expanded-dimension-text-color_name, [id*="dimension-text-color"], .selection span');

        for (const li of swatchesWithPrice) {
          const img = li.querySelector('img');

          // Tìm giá riêng của swatch này (thường nằm trong span con trực tiếp)
          // Ưu tiên tìm span chứa $ và số
          let swatchPrice = '';
          const allSpans = li.querySelectorAll('span');
          for (const span of allSpans) {
            const spanText = span.textContent?.trim() || '';
            // Chỉ lấy span có format giá (vd: $18.99, $20.99) và không quá dài
            if (/^\$?\d+\.\d{2}$/.test(spanText) || /^\$\d+\.\d{2}/.test(spanText)) {
              swatchPrice = spanText;
              break;
            }
          }

          // Fallback: tìm trong các element có class chứa "price"
          if (!swatchPrice) {
            const priceEl = li.querySelector('.a-color-price, [class*="price"]');
            if (priceEl) {
              const match = priceEl.textContent?.match(/\$?\d+\.\d{2}/);
              if (match) swatchPrice = match[0];
            }
          }

          // Nếu có img (có thể không cần giá cho một số sản phẩm)
          if (img) {
            // LẤY TÊN MÀU - ƯU TIÊN THEO THỨ TỰ
            let name = '';

            // 1. Lấy từ data-csa-c-item-id hoặc data attributes
            const dataItemId = li.getAttribute('data-csa-c-item-id');
            if (dataItemId) {
              // data-csa-c-item-id thường có format như "Black" hoặc "Navy_Blue"
              name = dataItemId.replace(/_/g, ' ');
            }

            // 2. Lấy từ title attribute (thường có "Click to select Black")
            if (!name) {
              const title = li.getAttribute('title') || '';
              if (title.includes('Click to select ')) {
                name = title.replace('Click to select ', '').trim();
              } else if (title) {
                name = title;
              }
            }

            // 3. Lấy từ aria-label
            if (!name) {
              const ariaLabel = li.getAttribute('aria-label') || '';
              if (ariaLabel) {
                name = ariaLabel.replace('Click to select ', '').trim();
              }
            }

            // 4. Lấy từ img alt
            if (!name) {
              const imgAlt = img.getAttribute('alt') || '';
              if (imgAlt && imgAlt.length < 50) {
                name = imgAlt;
              }
            }

            // 5. Lấy từ button bên trong nếu có
            if (!name) {
              const btn = li.querySelector('button');
              if (btn) {
                const btnTitle = btn.getAttribute('title') || btn.getAttribute('aria-label') || '';
                if (btnTitle) {
                  name = btnTitle.replace('Click to select ', '').trim();
                }
              }
            }

            // 6. Nếu không tìm được tên thực sự, bỏ qua swatch này
            if (!name) {
              continue; // Bỏ qua, không tạo "Color X"
            }

            name = name.replace(/\s+/g, ' ').trim();

            // Bỏ qua nếu tên không hợp lệ hoặc quá dài
            if (!name || name.length < 1 || name.length > 80) continue;
            // Bỏ qua nếu tên là giá tiền
            if (/^\$?\d+\.?\d*$/.test(name)) continue;
            // Bỏ qua các icon/logo Amazon
            if (isInvalidVariantName(name)) {
              console.log(`   [SKIP] Skipping icon/badge: "${name}"`);
              continue;
            }

            let imageUrl = img.src?.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.') || null;

            // Bỏ qua nếu URL ảnh là icon/badge
            if (isInvalidImageUrl(imageUrl)) {
              console.log(`   [SKIP] Skipping icon image URL`);
              continue;
            }

            console.log(`   [PRICE SWATCH] Found: name="${name}", price="${swatchPrice || 'N/A'}"`);

            const exists = buttons.find(b => b.name === name);
            if (!exists) {
              buttons.push({
                element: li,
                name: name,
                imageUrl: imageUrl,
                swatchPrice: swatchPrice
              });
            }
          }
        }

        if (buttons.length > 0) {
          console.log(`✅ [PRICE SWATCH] Found ${buttons.length} swatches with prices`);
          return buttons;
        }

        // Tìm tất cả row có chứa text "Color:"
        const allRows = document.querySelectorAll('#twister_feature_div .a-row, #twister .a-row, .a-section');
        for (const row of allRows) {
          const rowText = row.textContent?.toLowerCase() || '';
          if (rowText.includes('color:') || rowText.includes('color :')) {
            console.log('🔍 [ULTIMATE] Found potential color row:', row.innerHTML?.substring(0, 200));

            // Tìm tất cả li hoặc img trong row này
            const imgs = row.querySelectorAll('li img, div img');
            console.log(`   Found ${imgs.length} images in color row`);

            imgs.forEach((img, index) => {
              const li = img.closest('li') || img.parentElement;
              if (!li) return;

              // Bỏ qua video icon
              if (img.src?.includes('video') || img.src?.includes('play')) return;

              let name = li.getAttribute('title')?.replace('Click to select ', '') ||
                         img.getAttribute('alt') ||
                         ''; // Không dùng fallback Color X
              name = name.replace(/\s+/g, ' ').trim();

              let imageUrl = img.src?.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.') || null;

              // Tìm giá trong hoặc gần li
              const priceEl = li.querySelector('span[class*="price"], .a-price, .a-color-price') ||
                              li.parentElement?.querySelector('span[class*="price"]');
              let swatchPrice = priceEl?.textContent?.trim() || '';

              console.log(`   [ULTIMATE IMG] Color[${index}]: name="${name}", price="${swatchPrice}"`);

              const exists = buttons.find(b => b.name === name);
              if (!exists && name && name.length > 0 && name.length < 80) {
                buttons.push({
                  element: li,
                  name: name,
                  imageUrl: imageUrl,
                  swatchPrice: swatchPrice
                });
              }
            });

            if (buttons.length > 0) break;
          }
        }

        // NẾU VẪN KHÔNG TÌM THẤY: Tìm tất cả img có alt và nằm trong vùng swatch
        if (buttons.length === 0) {
          console.log('🔍 [LAST RESORT] Searching for any swatch images with alt...');

          const anySwatchImgs = document.querySelectorAll('#imageSwatches img, .imageSwatches img, #twister img[alt], #rightCol .a-section img[alt]');
          console.log(`   Found ${anySwatchImgs.length} potential swatch images`);

          anySwatchImgs.forEach((img, index) => {
            // Bỏ qua main product image
            if (img.id === 'landingImage' || img.closest('#imageBlock')) return;
            if (img.src?.includes('video') || img.src?.includes('play')) return;

            const li = img.closest('li') || img.parentElement;
            if (!li) return;

            // LẤY TÊN - CẢI TIẾN
            let name = '';

            // 1. data attributes
            const dataItemId = li.getAttribute('data-csa-c-item-id');
            if (dataItemId) name = dataItemId.replace(/_/g, ' ');

            // 2. title attribute
            if (!name) {
              const title = li.getAttribute('title') || '';
              if (title.includes('Click to select ')) {
                name = title.replace('Click to select ', '').trim();
              }
            }

            // 3. aria-label
            if (!name) {
              name = li.getAttribute('aria-label')?.replace('Click to select ', '') || '';
            }

            // 4. img alt
            if (!name) {
              const imgAlt = img.getAttribute('alt') || '';
              if (imgAlt && imgAlt.length < 50) name = imgAlt;
            }

            // 5. fallback
            // Nếu không tìm được tên thực sự, bỏ qua
            if (!name) return;

            name = name.replace(/\s+/g, ' ').trim();

            // Bỏ qua nếu tên không hợp lệ
            if (!name || name.length < 2 || name.length > 80) return;
            // Bỏ qua nếu là tên sản phẩm (quá dài)
            if (name.split(' ').length > 6) return;

            let imageUrl = img.src?.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.') || null;

            console.log(`   [LAST RESORT] Option[${index}]: name="${name}"`);

            const exists = buttons.find(b => b.name === name);
            if (!exists && name) {
              buttons.push({
                element: li,
                name: name,
                imageUrl: imageUrl,
                swatchPrice: ''
              });
            }
          });
        }

        // Return sớm nếu đã tìm được từ ultimate/last resort fallback
        if (buttons.length > 0) {
          console.log(`✅ [ULTIMATE/LAST RESORT] Found ${buttons.length} color options`);
          return buttons;
        }

        // Tìm tất cả img trong swatches
        let allSwatchImgs = [];
        for (const sel of ['#twister li[data-defaultasin] img', '#variation_color_name li img', '.twisterImages li img', 'ul.swatches li img', '[id*="variation"] li img', '#twister_feature_div li img']) {
          const found = document.querySelectorAll(sel);
          if (found.length > 0) {
            allSwatchImgs = found;
            console.log(`🔍 [FALLBACK] Found ${found.length} images with selector: ${sel}`);
            break;
          }
        }

        // Nếu không tìm thấy img, thử tìm li có data-defaultasin
        if (allSwatchImgs.length === 0) {
          const swatchLis = document.querySelectorAll('#twister li[data-defaultasin], [id*="variation"] li[data-defaultasin], [id*="twister"] li[data-defaultasin]');
          console.log(`🔍 [FALLBACK] Found ${swatchLis.length} LIs with data-defaultasin`);

          swatchLis.forEach((li, index) => {
            const img = li.querySelector('img');

            // LẤY TÊN - CẢI TIẾN
            let name = '';
            const dataItemId = li.getAttribute('data-csa-c-item-id');
            if (dataItemId) name = dataItemId.replace(/_/g, ' ');
            if (!name) name = li.getAttribute('title')?.replace('Click to select ', '') || '';
            if (!name) name = li.getAttribute('aria-label')?.replace('Click to select ', '') || '';
            if (!name && img) name = img.getAttribute('alt') || '';
            if (!name) name = li.textContent?.trim()?.split('\n')[0] || '';
            // Nếu không tìm được tên thực sự, bỏ qua
            if (!name) return;
            name = name.replace(/\s+/g, ' ').trim();

            // Bỏ qua nếu tên không hợp lệ hoặc quá dài
            if (!name || name.length < 2 || name.length > 80) return;
            // Bỏ qua nếu tên là giá
            if (/^\$?\d+\.?\d*$/.test(name)) return;

            let imageUrl = img?.src?.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.') || null;

            const priceSpan = li.querySelector('.a-color-price, .twisterSwatchPrice');
            let swatchPrice = priceSpan?.textContent?.trim() || '';

            console.log(`   [FALLBACK LI] Swatch[${index}]: name="${name.substring(0, 40)}", price="${swatchPrice}"`);

            const exists = buttons.find(b => b.name === name);
            if (!exists && name && name.length > 0) {
              buttons.push({
                element: li,
                name: name,
                imageUrl: imageUrl,
                swatchPrice: swatchPrice
              });
            }
          });
        } else {
          allSwatchImgs.forEach((img, index) => {
            const li = img.closest('li');
            if (!li) return;

            // Bỏ qua nếu unavailable
            if (li.classList.contains('swatchUnavailable')) return;

            // LẤY TÊN - CẢI TIẾN
            let name = '';
            const dataItemId = li.getAttribute('data-csa-c-item-id');
            if (dataItemId) name = dataItemId.replace(/_/g, ' ');
            if (!name) name = li.getAttribute('title')?.replace('Click to select ', '') || '';
            if (!name) name = li.getAttribute('aria-label')?.replace('Click to select ', '') || '';
            if (!name) name = img.getAttribute('alt') || '';
            // Nếu không tìm được tên thực sự, bỏ qua
            if (!name) return;
            name = name.replace(/\s+/g, ' ').trim();

            // Bỏ qua nếu tên là giá
            if (/^\$?\d+\.?\d*$/.test(name)) return;

            let imageUrl = img.src?.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.') || null;

            const priceSpan = li.querySelector('.a-color-price, .twisterSwatchPrice');
            let swatchPrice = priceSpan?.textContent?.trim() || '';

            console.log(`   [FALLBACK IMG] Swatch[${index}]: name="${name}", price="${swatchPrice}"`);

            const exists = buttons.find(b => b.name === name);
            if (!exists && name) {
              buttons.push({
                element: li,
                name: name,
                imageUrl: imageUrl,
                swatchPrice: swatchPrice
              });
            }
          });
        }

        if (buttons.length > 0) {
          console.log(`✅ [FALLBACK] Found ${buttons.length} color swatches`);
          return buttons;
        }
      }

      // Nếu tìm Size
      if (containerId === 'size_name') {
        console.log('🔍 [SIZE FALLBACK] Searching for size buttons/dropdown...');

        // ========== THỬ TÌM DROPDOWN SELECT TRƯỚC ==========
        const sizeDropdown = document.querySelector(
          'select[id*="native_dropdown_selected_size_name"], ' +
          'select[id*="size_name"], ' +
          'select[name*="size"], ' +
          '#native_dropdown_selected_size_name_0'
        );

        if (sizeDropdown) {
          console.log('🔍 [SIZE DROPDOWN] Found size dropdown!');
          const options = sizeDropdown.querySelectorAll('option');

          options.forEach((option, index) => {
            const value = option.value?.trim();
            const text = option.textContent?.trim();

            // Bỏ qua option "Select" hoặc rỗng hoặc -1
            if (!text || text.toLowerCase() === 'select' || value === '-1' || value === '') return;

            // Bỏ qua nếu option bị disabled
            if (option.disabled) return;

            console.log(`   [SIZE DROPDOWN] Option[${index}]: value="${value}", text="${text}"`);

            const exists = buttons.find(b => b.name === text);
            if (!exists) {
              buttons.push({
                element: option, // Lưu option element
                name: text,
                imageUrl: null,
                swatchPrice: '',
                isDropdown: true, // Đánh dấu là dropdown
                dropdownSelect: sizeDropdown // Reference đến select element
              });
            }
          });

          if (buttons.length > 0) {
            console.log(`✅ [SIZE DROPDOWN] Found ${buttons.length} size options from dropdown`);
            return buttons;
          }
        }

        // ========== NẾU KHÔNG CÓ DROPDOWN, TÌM BUTTONS ==========
        // Tìm text buttons cho size - MỞ RỘNG SELECTORS
        let sizeElements = [];

        // Thử nhiều selectors khác nhau cho size buttons của Amazon
        const sizeSelectors = [
          '#variation_size_name li[data-defaultasin]',
          '#variation_size_name li.swatchAvailable',
          '#variation_size_name button',
          '#variation_size_name span.a-button',
          '[id*="size_name"] li',
          '[id*="size_name"] button',
          '#twister_feature_div [id*="size"] li',
          '#twister_feature_div [id*="size"] button',
          // Amazon text buttons for size
          '#variation_size_name .a-button-text',
          '#variation_size_name .swatch-title-text',
          '.swatch-list-item-text',
          // Native buttons
          '#native_size_name_*',
        ];

        for (const sel of sizeSelectors) {
          const found = document.querySelectorAll(sel);
          if (found.length > 0) {
            sizeElements = Array.from(found);
            console.log(`🔍 [SIZE FALLBACK] Found ${found.length} elements with selector: ${sel}`);
            break;
          }
        }

        // Nếu không tìm thấy, thử tìm theo label "Size:"
        if (sizeElements.length === 0) {
          console.log('🔍 [SIZE FALLBACK] Trying to find size section by label...');
          const allLabels = document.querySelectorAll('label, span.a-form-label, .a-row span');
          for (const label of allLabels) {
            const labelText = (label.textContent || '').toLowerCase();
            if (labelText.includes('size:') || labelText.includes('size :')) {
              // Tìm parent section và lấy tất cả buttons/spans có thể click
              const parentSection = label.closest('.a-section') || label.closest('.a-row') || label.closest('div[id*="variation"]') || label.parentElement?.parentElement;
              if (parentSection) {
                console.log('🔍 [SIZE FALLBACK] Found size section via label');
                // Tìm tất cả clickable elements trong section này
                const clickables = parentSection.querySelectorAll('button, span.a-button-text, li, span[role="button"], .a-button');
                sizeElements = Array.from(clickables).filter(el => {
                  const text = el.textContent?.trim() || '';
                  // Filter ra chỉ những element có text ngắn (size names)
                  return text.length > 0 && text.length < 30 && !text.includes('$');
                });
                console.log(`   Found ${sizeElements.length} potential size elements in section`);
                if (sizeElements.length > 0) break;
              }
            }
          }
        }

        // Parse size elements
        sizeElements.forEach((el, index) => {
          // Bỏ qua nếu disabled hoặc unavailable
          if (el.classList.contains('swatchUnavailable') ||
              el.classList.contains('a-button-unavailable') ||
              el.getAttribute('aria-disabled') === 'true') return;

          let name = '';

          // Lấy tên từ nhiều nguồn khác nhau
          if (el.getAttribute('title')) {
            name = el.getAttribute('title').replace('Click to select ', '').trim();
          } else if (el.querySelector('.a-button-text')) {
            name = el.querySelector('.a-button-text').textContent?.trim() || '';
          } else if (el.querySelector('.a-size-base')) {
            name = el.querySelector('.a-size-base').textContent?.trim() || '';
          } else {
            name = el.textContent?.trim()?.split('\n')[0] || '';
          }

          name = name.replace(/\s+/g, ' ').trim();

          // Bỏ qua nếu tên không hợp lệ hoặc quá dài
          if (!name || name.length === 0 || name.length > 30) return;
          // Bỏ qua nếu là giá
          if (name.includes('$') || /^\d+\.\d{2}$/.test(name)) return;

          console.log(`   [SIZE FALLBACK] Size[${index}]: name="${name}"`);

          // Tìm element parent có thể click
          const clickableElement = el.closest('li') || el.closest('button') || el.closest('.a-button') || el;

          const exists = buttons.find(b => b.name === name);
          if (!exists && name) {
            buttons.push({
              element: clickableElement,
              name: name,
              imageUrl: null,
              swatchPrice: ''
            });
          }
        });

        if (buttons.length > 0) {
          console.log(`✅ [SIZE FALLBACK] Found ${buttons.length} size options:`, buttons.map(b => b.name));
          return buttons;
        }
      }

      // Nếu tìm Style
      if (containerId === 'style_name') {
        let styleLis = [];
        for (const sel of ['#variation_style_name li[data-defaultasin]', '#variation_style_name li.swatchAvailable', '[id*="style"] li[data-defaultasin]']) {
          const found = document.querySelectorAll(sel);
          if (found.length > 0) {
            styleLis = found;
            console.log(`🔍 [FALLBACK STYLE] Found ${found.length} styles with selector: ${sel}`);
            break;
          }
        }

        styleLis.forEach((li, index) => {
          if (li.classList.contains('swatchUnavailable')) return;

          const img = li.querySelector('img');
          let name = li.getAttribute('title')?.replace('Click to select ', '') ||
                     (img ? img.getAttribute('alt') : '') ||
                     li.querySelector('.a-size-base')?.textContent?.trim() ||
                     `Style ${index + 1}`;
          name = name.replace(/\s+/g, ' ').trim();

          let imageUrl = img?.src?.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.') || null;

          console.log(`   [FALLBACK STYLE] Style[${index}]: name="${name}"`);

          const exists = buttons.find(b => b.name === name);
          if (!exists && name && name.length > 0) {
            buttons.push({
              element: li,
              name: name,
              imageUrl: imageUrl,
              swatchPrice: ''
            });
          }
        });

        if (buttons.length > 0) {
          console.log(`✅ [FALLBACK] Found ${buttons.length} style options`);
          return buttons;
        }
      }

      return buttons;
    }

    // Có container - parse swatches từ container
    console.log(`🔍 [DEBUG] Container HTML preview:`, container.innerHTML?.substring(0, 500));

    const lis = container.querySelectorAll('li[data-defaultasin]:not(.swatchUnavailable):not(.swatchPageButton), li.swatchAvailable:not(.swatchPageButton), li.swatch-list-item-original');

    console.log(`🔍 [DEBUG] Found ${lis.length} LIs in ${containerId}`);

    lis.forEach((li, index) => {
      const img = li.querySelector('img');
      let name = '';

      // Lấy tên từ title hoặc img alt
      const titleAttr = li.getAttribute('title');
      if (titleAttr) {
        name = titleAttr.replace('Click to select ', '').trim();
      }
      if (!name && img) {
        name = img.getAttribute('alt') || '';
      }
      if (!name) {
        const textSpan = li.querySelector('.a-size-base');
        name = textSpan?.textContent?.trim() || li.textContent?.trim()?.split('\n')[0] || 'Unknown';
      }

      // Clean name
      name = name.replace(/\s+/g, ' ').trim();
      if (name.length > 60) name = name.substring(0, 60);

      // Lấy ảnh
      let imageUrl = null;
      if (img && img.src) {
        imageUrl = img.src.replace(/\._[A-Z0-9_,]+_\./, '._AC_SL1500_.');
      }

      // Lấy giá từ swatch nếu có
      const priceSpan = li.querySelector('.a-color-price, .twisterSwatchPrice');
      let swatchPrice = priceSpan?.textContent?.trim() || '';

      console.log(`   [DEBUG] LI[${index}]: name="${name}", hasImg=${!!img}, price="${swatchPrice}"`);

      // Tránh duplicate
      const exists = buttons.find(b => b.name === name);
      if (!exists && name && name !== 'Unknown') {
        buttons.push({
          element: li,
          name: name,
          imageUrl: imageUrl,
          swatchPrice: swatchPrice
        });
      }
    });

    console.log(`✅ [DEBUG] Total valid buttons for ${containerId}:`, buttons.length);
    return buttons;
  }

  // ========== LẤY TỪNG LOẠI VARIATION RIÊNG BIỆT ==========
  console.log('========== SCANNING VARIATIONS ==========');

  const colorButtons = getVariationButtons('color_name');
  const sizeButtons = getVariationButtons('size_name');
  const styleButtons = getVariationButtons('style_name');

  console.log('🎨 [AMAZON] Colors:', colorButtons.length, colorButtons.map(b => b.name));
  console.log('📏 [AMAZON] Sizes:', sizeButtons.length, sizeButtons.map(b => b.name));
  console.log('✨ [AMAZON] Styles:', styleButtons.length, styleButtons.map(b => b.name));

  // Xác định loại variation chính (có ảnh) và phụ
  let primaryVariation = null;
  let primaryType = '';
  let secondaryVariation = null;
  let secondaryType = '';

  if (styleButtons.length > 0) {
    primaryVariation = styleButtons;
    primaryType = 'style';
    if (sizeButtons.length > 0) {
      secondaryVariation = sizeButtons;
      secondaryType = 'size';
    } else if (colorButtons.length > 0) {
      secondaryVariation = colorButtons;
      secondaryType = 'color';
    }
  } else if (colorButtons.length > 0) {
    primaryVariation = colorButtons;
    primaryType = 'color';
    if (sizeButtons.length > 0) {
      secondaryVariation = sizeButtons;
      secondaryType = 'size';
    }
  } else if (sizeButtons.length > 0) {
    primaryVariation = sizeButtons;
    primaryType = 'size';
  }

  console.log(`🔹 [AMAZON] Primary: ${primaryType} (${primaryVariation?.length || 0})`);
  console.log(`🔹 [AMAZON] Secondary: ${secondaryType} (${secondaryVariation?.length || 0})`);

  // ========== CLICK VÀ LẤY GIÁ TỪNG VARIANT ==========
  console.log('========== CLICKING VARIANTS ==========');

  if (primaryVariation && primaryVariation.length > 0) {
    for (let i = 0; i < primaryVariation.length; i++) {
      const primaryBtn = primaryVariation[i];

      console.log(`\n>>> [${i+1}/${primaryVariation.length}] Clicking: "${primaryBtn.name}"`);

      // Lấy giá TRƯỚC khi click
      const priceBefore = getAmazonPriceAndCurrency();
      console.log(`   [BEFORE CLICK] Price: ${priceBefore.price} ${priceBefore.currency} | raw: "${priceBefore.raw}"`);

      // Xử lý dropdown select
      if (primaryBtn.isDropdown && primaryBtn.dropdownSelect) {
        console.log(`   [DROPDOWN] Selecting option: "${primaryBtn.name}"`);
        const select = primaryBtn.dropdownSelect;
        const option = primaryBtn.element;

        // Đặt giá trị cho select
        select.value = option.value;

        // Trigger change event
        select.dispatchEvent(new Event('change', { bubbles: true }));

        // Đợi giá cập nhật
        await wait(1500);
      } else {
        // Click bình thường cho buttons/images
        primaryBtn.element.scrollIntoView({ block: 'center' });
        await wait(300);

        // Click vào button/img
        const clickTarget = primaryBtn.element.querySelector('button') ||
                            primaryBtn.element.querySelector('img') ||
                            primaryBtn.element;

        console.log(`   [DEBUG] Click target:`, clickTarget.tagName, clickTarget.className?.substring(0, 50));
        clickTarget.click();

        // Đợi trang cập nhật giá
        console.log(`   [DEBUG] Waiting 1500ms for price update...`);
        await wait(1500);
      }

      // Lấy giá SAU khi click
      const priceAfter = getAmazonPriceAndCurrency();
      console.log(`   [AFTER CLICK] Price: ${priceAfter.price} ${priceAfter.currency} | raw: "${priceAfter.raw}"`);

      if (secondaryVariation && secondaryVariation.length > 0) {
        // Có 2 loại variation
        for (let j = 0; j < secondaryVariation.length; j++) {
          const secondaryBtn = secondaryVariation[j];

          console.log(`      >>> [${j+1}/${secondaryVariation.length}] Clicking secondary: "${secondaryBtn.name}"`);

          // Xử lý dropdown select
          if (secondaryBtn.isDropdown && secondaryBtn.dropdownSelect) {
            console.log(`      [DROPDOWN] Selecting option: "${secondaryBtn.name}"`);
            const select = secondaryBtn.dropdownSelect;
            const option = secondaryBtn.element;

            // Đặt giá trị cho select
            select.value = option.value;

            // Trigger change event
            select.dispatchEvent(new Event('change', { bubbles: true }));

            // Đợi giá cập nhật
            await wait(1500);
          } else {
            // Click bình thường cho buttons
            secondaryBtn.element.scrollIntoView({ block: 'center' });
            await wait(200);

            const secondaryClickTarget = secondaryBtn.element.querySelector('button') ||
                                         secondaryBtn.element.querySelector('a') ||
                                         secondaryBtn.element;
            secondaryClickTarget.click();

            // Đợi giá cập nhật
            await wait(1000);
          }

          // ƯU TIÊN lấy giá từ swatch của primary hoặc secondary
          let finalPrice = null;
          let finalCurrency = '$';

          // Thử lấy từ primary swatch
          if (primaryBtn.swatchPrice) {
            const priceMatch = primaryBtn.swatchPrice.match(/\$?([\d.,]+)/);
            if (priceMatch) {
              finalPrice = parseFloat(priceMatch[1].replace(',', '.'));
              const currencyMatch = primaryBtn.swatchPrice.match(/([^\d\s.,]+)/);
              if (currencyMatch) finalCurrency = currencyMatch[1].trim() || '$';
            }
          }

          // Nếu không có, lấy từ trang
          if (!finalPrice || isNaN(finalPrice)) {
            const { price, currency } = getAmazonPriceAndCurrency();
            finalPrice = price;
            finalCurrency = currency || '$';
          }

          console.log(`      [RESULT] ${primaryBtn.name} + ${secondaryBtn.name} = ${finalPrice} ${finalCurrency}`);

          const variant = {
            price: finalPrice || 0,
            list_price: 0.0,
            currency: finalCurrency,
            quantity: 100
          };

          // Thêm các attributes riêng biệt
          variant[primaryType] = primaryBtn.name;
          variant[secondaryType] = secondaryBtn.name;

          if (primaryBtn.imageUrl) {
            variant.primary_image = { url: primaryBtn.imageUrl };
          }

          variants.push(variant);
        }
      } else {
        // Chỉ có 1 loại variation
        // ƯU TIÊN lấy giá từ swatch (nếu có), nếu không thì lấy từ trang
        let finalPrice = null;
        let finalCurrency = '$';

        // Parse giá từ swatchPrice nếu có
        if (primaryBtn.swatchPrice) {
          // swatchPrice có thể là "$18.99" hoặc "$20.99 In Stock" - lấy số đầu tiên
          const priceMatch = primaryBtn.swatchPrice.match(/\$?([\d.,]+)/);
          if (priceMatch) {
            finalPrice = parseFloat(priceMatch[1].replace(',', '.'));
            // Tìm currency symbol
            const currencyMatch = primaryBtn.swatchPrice.match(/([^\d\s.,]+)/);
            if (currencyMatch) {
              finalCurrency = currencyMatch[1].trim() || '$';
            }
          }
          console.log(`   [SWATCH PRICE] Parsed from swatch: ${finalPrice} ${finalCurrency}`);
        }

        // Nếu không có giá từ swatch, lấy từ trang chính
        if (!finalPrice || isNaN(finalPrice)) {
          const { price, currency } = getAmazonPriceAndCurrency();
          finalPrice = price;
          finalCurrency = currency || '$';
          console.log(`   [PAGE PRICE] Using page price: ${finalPrice} ${finalCurrency}`);
        }

        console.log(`   [RESULT] ${primaryBtn.name} = ${finalPrice} ${finalCurrency}`);

        const variant = {
          price: finalPrice || 0,
          list_price: 0.0,
          currency: finalCurrency,
          quantity: 100
        };

        variant[primaryType] = primaryBtn.name;

        if (primaryBtn.imageUrl) {
          variant.primary_image = { url: primaryBtn.imageUrl };
        }

        variants.push(variant);
      }
    }
  } else {
    // Không có biến thể
    console.log('🔵 [AMAZON] Không có biến thể, lấy giá trực tiếp');

    const { price, currency } = getAmazonPriceAndCurrency();
    console.log('💵 [AMAZON] Single product price:', price, currency);

    variants.push({
      price: price || 0,
      list_price: 0.0,
      currency: currency || '$',
      quantity: 100
    });
  }

  console.log('========== FINAL RESULTS ==========');
  console.log('✅ [AMAZON] Total variants collected:', variants.length);
  console.log('✅ [AMAZON] Variants:', JSON.stringify(variants, null, 2));

  const result = {
    title,
    description,
    source: 'amazon',
    thumbnailImg: thumbnailImages,
    variants
  };

  console.log('✅ [AMAZON] scrapeAmazonData result:', result);
  return result;
}


async function scrapeProductData() {
  const host = window.location.host;
  console.log('🌐 Current host:', host);

  // Match bất kỳ domain nào chứa "aliexpress." (vd .com, .us, .ru…)
  if (/aliexpress\.\w+$/.test(host)) {
    console.log('🛒 Scraping AliExpress...');
    return scrapeAliExpressData();
  }
  if (host.includes('temu.com')) {
    console.log('🛒 Scraping Temu...');
    return scrapeTemuData();
  }
  if (host.includes('etsy.com')) {
    console.log('🛒 Scraping Etsy...');
    return scrapeEtsyData();
  }
  if (host.includes('amazon.')) {
    console.log('🛒 Scraping Amazon...');
    return scrapeAmazonData();
  }
  throw new Error(`Unsupported site: ${host}`);
}


// Hàm gửi dữ liệu lên API (đi qua background để tránh CSP)
async function sendProductDataToAPI(productData, tokenOverride) {
  if (!productData) throw new Error('productData is empty');
  const stored = await chrome.storage.local.get('accessToken');
  const accessToken = tokenOverride || stored.accessToken;
  const url = `${apiUrl}/api/ex/product/`;

  const resp = await chrome.runtime.sendMessage({
    type: 'EX_API_POST_PRODUCT',
    payload: { url, data: productData, token: accessToken }
  });

  if (!resp) throw new Error('No response from background');
  if (!resp.ok) {
    if (resp.status === 401) {
      const newAccessToken = await refreshAccessToken();
      return await sendProductDataToAPI(productData, newAccessToken);
    }
    throw new Error(`API lỗi ${resp.status}: ${resp.body}`);
  }
  return true;
}


function isAccessTokenExpired(token) {
    try {
        const decoded = jwt_decode(token);
        const currentTime = Date.now() / 1000;
        return decoded.exp < currentTime;
    } catch (error) {
        console.error("Invalid token", error);
        return true;
    }
}
async function refreshAccessToken() {
  const { refreshToken } = await chrome.storage.local.get('refreshToken');

  const response = await fetch(`${apiUrl}/api/token/refresh/`, {
      method: 'POST',
      headers: {
          'Content-Type': 'application/json',
      },
      body: JSON.stringify({
          refresh: refreshToken
      })
  });

  if (!response.ok) {
    // Nếu không thể làm mới token, thông báo lỗi và yêu cầu người dùng đăng nhập lại
    alert('Token đã hết hạn. Vui lòng đăng nhập lại để tiếp tục.');
    promptUserToLogin();  // Gọi hàm để yêu cầu người dùng đăng nhập lại
    throw new Error('Không thể làm mới token');
  }

  const data = await response.json();
  await chrome.storage.local.set({
      accessToken: data.access,
      refreshToken: data.refresh
  });

  return data.access;
}

// Hàm yêu cầu người dùng đăng nhập lại
function promptUserToLogin() {
  // Xóa token cũ
  chrome.storage.local.remove(['accessToken', 'refreshToken']);

  // Thông báo người dùng mở popup extension để đăng nhập lại
  alert('Phiên đăng nhập đã hết hạn. Vui lòng click vào icon extension để đăng nhập lại.');
}


