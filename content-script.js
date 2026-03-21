"use strict";

(function () {
  const browserApi = typeof browser !== "undefined"
    ? browser
    : (typeof chrome !== "undefined" ? chrome : null);
  const SETTINGS_KEY = "serverSettings";
  const LAST_DEPARTMENT_KEY = "lastDepartment";
  const PANEL_ID = "walmart-food-import-helper-panel";
  const DEFAULT_WEEK_SERVINGS = "7";
  const OFF_PRODUCT_FIELDS = [
    "code",
    "product_name",
    "brands",
    "quantity",
    "serving_size",
    "serving_quantity",
    "nutriments",
    "product_quantity"
  ].join(",");
  let panelElements = null;
  let currentUrl = location.href;
  const nutritionLookupCache = new Map();
  let refreshSequenceToken = 0;

  if (!browserApi || location.hostname !== "www.walmart.com") {
    return;
  }

  function parseJson(text) {
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function normalizeText(value) {
    if (value === null || value === undefined) {
      return null;
    }

    const text = String(value).trim();
    return text === "" ? null : text;
  }

  function extractItemIdFromUrl(url) {
    const match = String(url || "").match(/\/(\d+)(?:[/?#]|$)/);
    return match ? match[1] : null;
  }

  function normalizeBarcode(value) {
    const digits = String(value || "").replace(/\D+/g, "");
    if (digits.length < 8 || digits.length > 14) {
      return null;
    }

    return digits;
  }

  function formatPrice(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    const cleaned = typeof value === "string"
      ? value.replace(/[^0-9.\-]/g, "")
      : value;
    const number = Number(cleaned);

    if (!Number.isFinite(number)) {
      return null;
    }

    return number.toFixed(2);
  }

  function normalizeNumberValue(value) {
    const text = normalizeText(value);
    if (!text) {
      return "";
    }

    const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? match[0] : "";
  }

  function getEmptyNutrition() {
    return {
      servings: "",
      calories: "",
      fat: "",
      protein: "",
      carbs: "",
      fiber: ""
    };
  }

  function hasNutritionValues(nutrition) {
    return Boolean(nutrition && Object.values(nutrition).some((value) => value !== ""));
  }

  function getMissingNutritionFields(nutrition) {
    const source = nutrition || getEmptyNutrition();
    return ["calories", "fat", "protein", "carbs", "fiber"]
      .filter((field) => !normalizeText(source[field]));
  }

  function mergeNutrition(primary, fallback) {
    const base = primary || getEmptyNutrition();
    const incoming = fallback || getEmptyNutrition();

    return {
      servings: base.servings || incoming.servings || "",
      calories: base.calories || incoming.calories || "",
      fat: base.fat || incoming.fat || "",
      protein: base.protein || incoming.protein || "",
      carbs: base.carbs || incoming.carbs || "",
      fiber: base.fiber || incoming.fiber || ""
    };
  }

  function getNextData(root = document) {
    return parseJson(root.getElementById("__NEXT_DATA__")?.textContent || "");
  }

  function getJsonLdBlocks(root = document) {
    return Array.from(root.querySelectorAll('script[type="application/ld+json"]'))
      .map((node) => parseJson(node.textContent))
      .filter(Boolean);
  }

  function findProductJsonLd(value) {
    if (!value) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = findProductJsonLd(item);
        if (result) {
          return result;
        }
      }
      return null;
    }

    if (typeof value !== "object") {
      return null;
    }

    if (value["@type"] === "Product") {
      return value;
    }

    for (const nested of Object.values(value)) {
      const result = findProductJsonLd(nested);
      if (result) {
        return result;
      }
    }

    return null;
  }

  function lastNonEmpty(values) {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const value = normalizeText(values[index]);
      if (!value || /^(home|walmart)$/i.test(value)) {
        continue;
      }
      return value;
    }

    return null;
  }

  function extractAisleCode(text) {
    const value = normalizeText(text);
    if (!value) {
      return null;
    }

    const patterns = [
      /\baisle(?:\s*[:#-])?\s*([a-z]?\d+[a-z0-9-]*)\b/i,
      /\bin\s+([a-z]?\d+[a-z0-9-]*)\s+aisle\b/i,
      /\blocation(?:\s*[:#-])?\s*([a-z]?\d+[a-z0-9-]*)\b/i
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match && match[1]) {
        return match[1].toUpperCase();
      }
    }

    if (/^[a-z]?\d+[a-z0-9-]*$/i.test(value)) {
      return value.toUpperCase();
    }

    return null;
  }

  function extractAisleFromObject(value, depth) {
    if (depth > 5 || value === null || value === undefined) {
      return null;
    }

    if (typeof value === "string" || typeof value === "number") {
      return extractAisleCode(String(value));
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = extractAisleFromObject(entry, depth + 1);
        if (found) {
          return found;
        }
      }
      return null;
    }

    if (typeof value !== "object") {
      return null;
    }

    const priorityKeys = [
      "aisle",
      "aisleLocation",
      "storeAisle",
      "pickupAisle",
      "location",
      "locationText",
      "storeLocation",
      "shelfLocation",
      "fulfillmentLabel",
      "fulfillmentOptions",
      "fulfillmentSummary",
      "fulfillmentBadge"
    ];

    for (const key of priorityKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = extractAisleFromObject(value[key], depth + 1);
        if (found) {
          return found;
        }
      }
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (!/(aisle|location|shelf|fulfillment)/i.test(key)) {
        continue;
      }

      const found = extractAisleFromObject(nestedValue, depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  }

  function extractBarcodeFromObject(value, depth) {
    if (depth > 5 || value === null || value === undefined) {
      return null;
    }

    if (typeof value === "string" || typeof value === "number") {
      return normalizeBarcode(value);
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = extractBarcodeFromObject(entry, depth + 1);
        if (found) {
          return found;
        }
      }
      return null;
    }

    if (typeof value !== "object") {
      return null;
    }

    const priorityKeys = [
      "upc",
      "barcode",
      "barCode",
      "ean",
      "ean13",
      "gtin",
      "gtin12",
      "gtin13",
      "gtin14",
      "globalTradeItemNumber"
    ];

    for (const key of priorityKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = extractBarcodeFromObject(value[key], depth + 1);
        if (found) {
          return found;
        }
      }
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      if (!/(barcode|ean|upc|gtin)/i.test(key)) {
        continue;
      }

      const found = extractBarcodeFromObject(nestedValue, depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  }

  function extractBarcodeFromJsonLdProduct(product) {
    if (!product || typeof product !== "object") {
      return null;
    }

    return normalizeBarcode(
      product.gtin13 ||
      product.gtin12 ||
      product.gtin14 ||
      product.gtin ||
      product.barcode
    );
  }

  function extractBarcodeFromJsonLd(root = document) {
    for (const block of getJsonLdBlocks(root)) {
      const product = findProductJsonLd(block);
      const found = extractBarcodeFromJsonLdProduct(product);
      if (found) {
        return found;
      }
    }

    return null;
  }

  function extractAisleFromDom(root = document) {
    const selectors = [
      '[data-testid*="aisle" i]',
      '[data-automation-id*="aisle" i]',
      '[aria-label*="aisle" i]',
      '[data-testid*="location" i]',
      '[data-automation-id*="location" i]'
    ];

    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        const found = extractAisleCode(node.getAttribute("aria-label")) || extractAisleCode(node.textContent);
        if (found) {
          return found;
        }
      }
    }

    return extractAisleCode(root.body?.innerText || root.documentElement?.innerText || "");
  }

  function extractDepartmentFromDom(root = document) {
    const aisle = extractAisleFromDom(root);
    if (aisle) {
      return aisle;
    }

    const selectors = [
      'nav[aria-label*="breadcrumb" i] a',
      '[data-testid*="breadcrumb" i] a'
    ];
    const labels = [];

    selectors.forEach((selector) => {
      root.querySelectorAll(selector).forEach((node) => {
        labels.push(node.textContent);
      });
    });

    return lastNonEmpty(labels);
  }

  function normalizeNutritionList(items) {
    const nutrition = getEmptyNutrition();

    for (const item of items || []) {
      const label = normalizeText(
        item?.name || item?.label || item?.displayName || item?.title || item?.nutrientName
      );
      const rawValue = item?.amount ?? item?.value ?? item?.quantity ?? item?.displayValue ?? item?.text;
      if (!label) {
        continue;
      }

      const lowerLabel = label.toLowerCase();
      if (!nutrition.servings && /servings?/.test(lowerLabel)) {
        nutrition.servings = normalizeNumberValue(rawValue);
      } else if (!nutrition.calories && /calories?/.test(lowerLabel)) {
        nutrition.calories = normalizeNumberValue(rawValue);
      } else if (!nutrition.protein && /protein/.test(lowerLabel)) {
        nutrition.protein = normalizeNumberValue(rawValue);
      } else if (!nutrition.fat && /(total )?fat/.test(lowerLabel)) {
        nutrition.fat = normalizeNumberValue(rawValue);
      } else if (!nutrition.carbs && /(total )?carb/.test(lowerLabel)) {
        nutrition.carbs = normalizeNumberValue(rawValue);
      } else if (!nutrition.fiber && /fiber/.test(lowerLabel)) {
        nutrition.fiber = normalizeNumberValue(rawValue);
      }
    }

    return hasNutritionValues(nutrition) ? nutrition : null;
  }

  function normalizeNutritionCandidate(candidate) {
    if (!candidate) {
      return null;
    }

    if (Array.isArray(candidate)) {
      return normalizeNutritionList(candidate);
    }

    if (typeof candidate !== "object") {
      return null;
    }

    const nutrition = {
      servings: normalizeNumberValue(
        candidate.servingsPerContainer ?? candidate.servings ?? candidate.servingSize
      ),
      calories: normalizeNumberValue(candidate.calories ?? candidate.calorieContent),
      fat: normalizeNumberValue(candidate.fatContent ?? candidate.totalFatContent ?? candidate.fat),
      protein: normalizeNumberValue(candidate.proteinContent ?? candidate.protein),
      carbs: normalizeNumberValue(
        candidate.carbohydrateContent ?? candidate.totalCarbohydrateContent ?? candidate.carbs
      ),
      fiber: normalizeNumberValue(
        candidate.fiberContent ?? candidate.dietaryFiberContent ?? candidate.fiber
      )
    };

    if (hasNutritionValues(nutrition)) {
      return nutrition;
    }

    return normalizeNutritionList(
      candidate.nutrients || candidate.components || candidate.values || candidate.items || []
    );
  }

  function extractDepartmentFromProduct(product) {
    const aisle = extractAisleFromObject(product, 0);
    if (aisle) {
      return aisle;
    }

    const labels = [];
    const pathCandidates = [product?.categoryPath, product?.category?.path, product?.breadcrumbs];

    for (const candidate of pathCandidates) {
      if (!Array.isArray(candidate)) {
        continue;
      }

      for (const entry of candidate) {
        labels.push(entry?.name || entry?.title || entry?.label || entry);
      }
    }

    labels.push(product?.category);
    return lastNonEmpty(labels);
  }

  function extractNutritionFromProduct(product) {
    const candidates = [
      product?.nutrition,
      product?.nutritionFacts,
      product?.nutritionInformation,
      product?.nutritionalInfo,
      product?.nutritionFactsValues
    ];

    for (const candidate of candidates) {
      const normalized = normalizeNutritionCandidate(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  function extractFromProductData(nextData, pageUrl = location.href, pageTitle = document.title, root = document) {
    const product = nextData?.props?.pageProps?.initialData?.data?.product;
    if (!product) {
      return null;
    }

    const variantPriceInfo =
      product.id && product.variantsMap ? product.variantsMap[product.id]?.priceInfo : null;
    const priceInfo = product.priceInfo || variantPriceInfo;
    const currentPrice = priceInfo?.currentPrice;
    const rawPrice =
      currentPrice?.price ??
      currentPrice?.priceString ??
      currentPrice?.priceDisplay ??
      null;

    return {
      price: formatPrice(rawPrice),
      title: normalizeText(product.name || product.productName || pageTitle),
      itemId: extractItemIdFromUrl(pageUrl),
      barcode: extractBarcodeFromObject(product, 0) || extractBarcodeFromJsonLd(root),
      department: extractDepartmentFromProduct(product),
      nutrition: extractNutritionFromProduct(product),
      source: "product"
    };
  }

  function extractFromSearchResults(nextData, pageUrl = location.href, pageTitle = document.title, root = document) {
    const itemId = extractItemIdFromUrl(pageUrl);
    if (!itemId) {
      return null;
    }

    const stacks = nextData?.props?.pageProps?.initialData?.searchResult?.itemStacks || [];
    for (const stack of stacks) {
      for (const item of stack.items || []) {
        if (String(item.usItemId) !== itemId) {
          continue;
        }

        const priceInfo = item.priceInfo || {};
        const rawPrice =
          priceInfo.linePriceDisplay ??
          priceInfo.linePrice ??
          priceInfo.minPrice ??
          null;

        return {
          price: formatPrice(rawPrice),
          title: normalizeText(item.name || pageTitle),
          itemId,
          barcode: extractBarcodeFromObject(item, 0) || extractBarcodeFromJsonLd(root),
          department: extractAisleFromObject(item, 0) || extractDepartmentFromDom(root),
          nutrition: null,
          source: "search"
        };
      }
    }

    return null;
  }

  function extractFromJsonLd(root = document, pageUrl = location.href, pageTitle = document.title) {
    for (const block of getJsonLdBlocks(root)) {
      const product = findProductJsonLd(block);
      if (!product) {
        continue;
      }

      const offers = product.offers;
      const offer = Array.isArray(offers) ? offers[0] : offers;
      const rawPrice = offer?.price ?? offer?.priceSpecification?.price ?? null;

      return {
        price: formatPrice(rawPrice),
        title: normalizeText(product.name || pageTitle),
        itemId: extractItemIdFromUrl(pageUrl),
        barcode: extractBarcodeFromJsonLdProduct(product),
        department: normalizeText(product.category),
        nutrition: normalizeNutritionCandidate(product.nutrition),
        source: "json-ld"
      };
    }

    return null;
  }

  function buildResponse(
    data,
    pageUrl = location.href,
    pageTitle = document.title,
    root = document
  ) {
    const nutrition = normalizeNutritionCandidate(data?.nutrition) || data?.nutrition || getEmptyNutrition();
    const pageAisle = extractAisleFromDom(root);
    const directAisle = extractAisleCode(data?.department);
    const department = pageAisle || directAisle || data?.department || extractDepartmentFromDom(root) || null;

    return {
      url: pageUrl,
      title: data?.title || pageTitle || null,
      price: data?.price || null,
      itemId: data?.itemId || extractItemIdFromUrl(pageUrl),
      barcode: data?.barcode || extractBarcodeFromJsonLd(root),
      department,
      nutritionSource: data?.nutritionSource || null,
      nutrition: hasNutritionValues(nutrition) ? nutrition : getEmptyNutrition(),
      source: data?.source || "none"
    };
  }

  function formatStoredNutritionNumber(value) {
    if (!Number.isFinite(value)) {
      return "";
    }

    return String(Number(value.toFixed(2)));
  }

  function getFirstFiniteNumber(values) {
    for (const value of values) {
      const numeric = typeof value === "string" ? Number(value) : value;
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }

    return null;
  }

  function tokenizeSearchText(text) {
    const stopWords = new Set([
      "and", "with", "the", "for", "from", "pack", "count", "ct", "oz", "lb", "lbs",
      "ounce", "ounces", "bag", "box", "bottle", "can", "cans", "value", "size"
    ]);

    return Array.from(new Set(
      String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((token) => token && token.length > 1 && !stopWords.has(token))
    ));
  }

  function scoreOpenFoodFactsMatch(title, product) {
    const wantedTokens = tokenizeSearchText(title);
    if (wantedTokens.length === 0) {
      return 0;
    }

    const candidateText = [
      product?.product_name,
      product?.brands,
      product?.quantity
    ].filter(Boolean).join(" ");
    const candidateTokens = new Set(tokenizeSearchText(candidateText));

    let matches = 0;
    for (const token of wantedTokens) {
      if (candidateTokens.has(token)) {
        matches += 1;
      }
    }

    const numberTokens = wantedTokens.filter((token) => /\d/.test(token));
    let numberMatches = 0;
    for (const token of numberTokens) {
      if (candidateTokens.has(token)) {
        numberMatches += 1;
      }
    }

    return (matches / wantedTokens.length) + (numberMatches * 0.15);
  }

  function parseHtmlDocument(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function fetchPageDataFromUrl(pageUrl) {
    const response = await fetch(pageUrl, {
      method: "GET",
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`Walmart page fetch failed (${response.status}).`);
    }

    const html = await response.text();
    const root = parseHtmlDocument(html);
    const pageTitle = root.title || document.title;
    const nextData = getNextData(root);

    const fromProduct = extractFromProductData(nextData, pageUrl, pageTitle, root);
    if (fromProduct && (fromProduct.price || fromProduct.title)) {
      return buildResponse(fromProduct, pageUrl, pageTitle, root);
    }

    const fromSearch = extractFromSearchResults(nextData, pageUrl, pageTitle, root);
    if (fromSearch && (fromSearch.price || fromSearch.title)) {
      return buildResponse(fromSearch, pageUrl, pageTitle, root);
    }

    const fromJsonLd = extractFromJsonLd(root, pageUrl, pageTitle);
    if (fromJsonLd && (fromJsonLd.price || fromJsonLd.title)) {
      return buildResponse(fromJsonLd, pageUrl, pageTitle, root);
    }

    return buildResponse({ source: "none" }, pageUrl, pageTitle, root);
  }

  function normalizeOpenFoodFactsNutrition(product) {
    const nutriments = product?.nutriments || {};
    const nutrition = {
      servings: "",
      calories: formatStoredNutritionNumber(getFirstFiniteNumber([
        nutriments["energy-kcal_serving"],
        nutriments["energy-kcal"],
        nutriments["energy-kcal_100g"]
      ])),
      fat: formatStoredNutritionNumber(getFirstFiniteNumber([
        nutriments.fat_serving,
        nutriments.fat,
        nutriments.fat_100g
      ])),
      protein: formatStoredNutritionNumber(getFirstFiniteNumber([
        nutriments.proteins_serving,
        nutriments.proteins,
        nutriments.proteins_100g,
        nutriments.protein_serving,
        nutriments.protein,
        nutriments.protein_100g
      ])),
      carbs: formatStoredNutritionNumber(getFirstFiniteNumber([
        nutriments.carbohydrates_serving,
        nutriments.carbohydrates,
        nutriments.carbohydrates_100g
      ])),
      fiber: formatStoredNutritionNumber(getFirstFiniteNumber([
        nutriments.fiber_serving,
        nutriments.fiber,
        nutriments.fiber_100g
      ]))
    };

    if (!hasNutritionValues(nutrition)) {
      return null;
    }

    return nutrition;
  }

  async function fetchOpenFoodFactsJson(url) {
    const response = await fetch(url, {
      method: "GET"
    });

    if (!response.ok) {
      throw new Error(`Open Food Facts responded ${response.status}.`);
    }

    return response.json();
  }

  async function fetchOpenFoodFactsByBarcode(barcode) {
    const cleanBarcode = normalizeBarcode(barcode);
    if (!cleanBarcode) {
      return null;
    }

    const url = new URL(`https://world.openfoodfacts.org/api/v2/product/${cleanBarcode}`);
    url.searchParams.set("fields", OFF_PRODUCT_FIELDS);

    const json = await fetchOpenFoodFactsJson(url.toString());
    if (!json || json.status !== 1 || !json.product) {
      return null;
    }

    const nutrition = normalizeOpenFoodFactsNutrition(json.product);
    if (!nutrition) {
      return null;
    }

    return {
      source: "Open Food Facts barcode",
      sourceUrl: `https://world.openfoodfacts.org/product/${cleanBarcode}`,
      nutrition,
      matchedName: normalizeText(json.product.product_name)
    };
  }

  async function fetchOpenFoodFactsByTitle(title) {
    const cleanTitle = normalizeText(title);
    if (!cleanTitle) {
      return null;
    }

    const url = new URL("https://world.openfoodfacts.org/cgi/search.pl");
    url.searchParams.set("action", "process");
    url.searchParams.set("search_terms", cleanTitle);
    url.searchParams.set("search_simple", "1");
    url.searchParams.set("json", "1");
    url.searchParams.set("page_size", "8");
    url.searchParams.set("sort_by", "unique_scans_n");
    url.searchParams.set("fields", OFF_PRODUCT_FIELDS);

    const json = await fetchOpenFoodFactsJson(url.toString());
    const products = Array.isArray(json?.products) ? json.products : [];
    if (products.length === 0) {
      return null;
    }

    let bestProduct = null;
    let bestScore = 0;

    for (const product of products) {
      const nutrition = normalizeOpenFoodFactsNutrition(product);
      if (!nutrition) {
        continue;
      }

      const score = scoreOpenFoodFactsMatch(cleanTitle, product);
      if (score > bestScore) {
        bestScore = score;
        bestProduct = product;
      }
    }

    if (!bestProduct || bestScore < 0.45) {
      return null;
    }

    return {
      source: "Open Food Facts search",
      sourceUrl: bestProduct?.code
        ? `https://world.openfoodfacts.org/product/${bestProduct.code}`
        : url.toString(),
      nutrition: normalizeOpenFoodFactsNutrition(bestProduct),
      matchedName: normalizeText(bestProduct.product_name)
    };
  }

  async function lookupFallbackNutrition(data) {
    const cacheKey = data?.barcode
      ? `barcode:${data.barcode}`
      : `title:${String(data?.title || "").toLowerCase()}`;

    if (nutritionLookupCache.has(cacheKey)) {
      return nutritionLookupCache.get(cacheKey);
    }

    const lookupPromise = (async () => {
      try {
        const byBarcode = await fetchOpenFoodFactsByBarcode(data?.barcode);
        if (byBarcode) {
          return byBarcode;
        }

        return await fetchOpenFoodFactsByTitle(data?.title);
      } catch (error) {
        return null;
      }
    })();

    nutritionLookupCache.set(cacheKey, lookupPromise);
    return lookupPromise;
  }

  async function extractPageData() {
    const pageUrl = location.href;
    const pageTitle = document.title;
    const nextData = getNextData(document);
    const fromProduct = extractFromProductData(nextData, pageUrl, pageTitle, document);
    if (fromProduct && (fromProduct.price || fromProduct.title)) {
      return buildResponse(fromProduct, pageUrl, pageTitle, document);
    }

    const fromSearch = extractFromSearchResults(nextData, pageUrl, pageTitle, document);
    if (fromSearch && (fromSearch.price || fromSearch.title)) {
      return buildResponse(fromSearch, pageUrl, pageTitle, document);
    }

    const fromJsonLd = extractFromJsonLd(document, pageUrl, pageTitle);
    if (fromJsonLd && (fromJsonLd.price || fromJsonLd.title)) {
      return buildResponse(fromJsonLd, pageUrl, pageTitle, document);
    }

    return buildResponse({ source: "none" }, pageUrl, pageTitle, document);
  }

  function getDefaultSettings() {
    return {
      serverBaseUrl: "http://voncloft.shopping.com",
      addEndpoint: "/scripts/add_food_to_db.php"
    };
  }

  async function getStoredData() {
    return browserApi.storage.local.get({
      [SETTINGS_KEY]: getDefaultSettings(),
      [LAST_DEPARTMENT_KEY]: ""
    });
  }

  function buildServerUrl(settings) {
    if (!settings.serverBaseUrl || !settings.addEndpoint) {
      throw new Error("Server URL and add endpoint are required.");
    }

    return new URL(settings.addEndpoint, settings.serverBaseUrl).toString();
  }

  function stripHtml(text) {
    return String(text || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function submitFoodInsert(form, settings) {
    const targetUrl = buildServerUrl(settings);
    const body = new URLSearchParams();

    Object.entries(form).forEach(([key, value]) => {
      body.set(key, value);
    });
    body.set("format", "json");

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Accept": "application/json"
      },
      body: body.toString(),
      credentials: "include"
    });

    const responseText = await response.text();
    let json = null;

    try {
      json = JSON.parse(responseText);
    } catch (error) {
      json = null;
    }

    if (!response.ok) {
      throw new Error(json?.error || stripHtml(responseText) || `Server responded ${response.status}.`);
    }

    if (json && json.ok === false) {
      throw new Error(json.error || "Server returned ok=false.");
    }

    if (json && json.ok) {
      return json;
    }

    if (/Imported Ingredient to main food database/i.test(responseText)) {
      return { ok: true };
    }

    throw new Error(stripHtml(responseText) || "Server response did not confirm the insert.");
  }

  function setPanelStatus(message, tone) {
    if (!panelElements) {
      return;
    }

    panelElements.status.textContent = message;
    panelElements.status.dataset.tone = tone || "neutral";
    panelElements.status.style.color =
      tone === "good" ? "#0f5132" : tone === "bad" ? "#842029" : "#4a5568";
  }

  function setPanelBusy(isBusy) {
    if (!panelElements) {
      return;
    }

    panelElements.save.disabled = isBusy;
    panelElements.refresh.disabled = isBusy;
    panelElements.save.textContent = isBusy ? "Adding..." : "Add To Database";
  }

  function createField(labelText, tagName, inputType) {
    const field = document.createElement("label");
    field.style.display = "flex";
    field.style.flexDirection = "column";
    field.style.gap = "4px";
    field.style.fontSize = "12px";
    field.style.fontWeight = "600";
    field.style.color = "#5a4a3b";

    const label = document.createElement("span");
    label.textContent = labelText;

    const input = document.createElement(tagName);
    if (tagName === "input" && inputType) {
      input.type = inputType;
    }
    input.style.border = "1px solid #ccbda9";
    input.style.borderRadius = "8px";
    input.style.padding = "8px 10px";
    input.style.background = "#fffdf8";
    input.style.color = "#1d1a17";
    input.style.font = "inherit";
    input.style.width = "100%";
    input.style.boxSizing = "border-box";

    if (tagName === "textarea") {
      input.rows = 2;
      input.style.resize = "vertical";
    }

    field.append(label, input);
    return { field, input };
  }

  function setPanelOpen(isOpen) {
    if (!panelElements) {
      return;
    }

    panelElements.isOpen = Boolean(isOpen);
    panelElements.panel.style.display = panelElements.isOpen ? "block" : "none";
    panelElements.launcher.style.display = panelElements.isOpen ? "none" : "block";
  }

  function setLauncherLabel(text) {
    if (!panelElements) {
      return;
    }

    panelElements.launcher.textContent = text;
  }

  function setNutritionSource(source) {
    if (!panelElements) {
      return;
    }

    if (!source || !source.url) {
      panelElements.sourceRow.style.display = "none";
      panelElements.sourceLink.removeAttribute("href");
      panelElements.sourceLink.textContent = "";
      return;
    }

    panelElements.sourceRow.style.display = "block";
    panelElements.sourceLink.href = source.url;
    panelElements.sourceLink.textContent = source.label || source.url;
  }

  function runRefreshSequence() {
    const token = ++refreshSequenceToken;
    const delays = [0, 450, 1200, 2400];

    delays.forEach((delay) => {
      window.setTimeout(() => {
        if (token !== refreshSequenceToken) {
          return;
        }

        refreshInjectedPanel().catch((error) => {
          setPanelStatus(error.message || String(error), "bad");
        });
      }, delay);
    });
  }

  function createPanel() {
    if (location.hostname !== "www.walmart.com") {
      return null;
    }

    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      return panelElements;
    }

    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.textContent = "Food Import";
    launcher.style.position = "fixed";
    launcher.style.left = "18px";
    launcher.style.bottom = "18px";
    launcher.style.zIndex = "2147483647";
    launcher.style.border = "0";
    launcher.style.borderRadius = "999px";
    launcher.style.padding = "10px 14px";
    launcher.style.background = "#0f766e";
    launcher.style.color = "#ffffff";
    launcher.style.fontFamily = '"Trebuchet MS", "Segoe UI", sans-serif';
    launcher.style.fontSize = "13px";
    launcher.style.fontWeight = "700";
    launcher.style.boxShadow = "0 10px 28px rgba(15, 23, 42, 0.18)";
    launcher.style.cursor = "pointer";

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.position = "fixed";
    panel.style.left = "18px";
    panel.style.bottom = "18px";
    panel.style.zIndex = "2147483647";
    panel.style.width = "340px";
    panel.style.maxHeight = "calc(100vh - 36px)";
    panel.style.overflow = "auto";
    panel.style.padding = "14px";
    panel.style.border = "1px solid #d8dee8";
    panel.style.borderRadius = "14px";
    panel.style.background = "#fffaf0";
    panel.style.boxShadow = "0 16px 40px rgba(15, 23, 42, 0.18)";
    panel.style.fontFamily = '"Trebuchet MS", "Segoe UI", sans-serif';
    panel.style.color = "#1f2937";
    panel.style.boxSizing = "border-box";
    panel.style.display = "none";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "10px";
    header.style.marginBottom = "10px";

    const title = document.createElement("div");
    title.textContent = "Walmart Food Import";
    title.style.fontSize = "14px";
    title.style.fontWeight = "700";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.style.border = "1px solid #cbd5e1";
    close.style.borderRadius = "10px";
    close.style.padding = "6px 10px";
    close.style.background = "#ffffff";
    close.style.color = "#334155";
    close.style.fontWeight = "700";
    close.style.cursor = "pointer";

    const status = document.createElement("div");
    status.style.fontSize = "12px";
    status.style.lineHeight = "1.4";
    status.style.minHeight = "34px";
    status.style.marginBottom = "10px";

    const sourceRow = document.createElement("div");
    sourceRow.style.display = "none";
    sourceRow.style.marginBottom = "10px";
    sourceRow.style.fontSize = "12px";
    sourceRow.style.lineHeight = "1.4";
    sourceRow.style.color = "#5a4a3b";

    const sourceLabel = document.createElement("span");
    sourceLabel.textContent = "Nutrition Source: ";

    const sourceLink = document.createElement("a");
    sourceLink.target = "_blank";
    sourceLink.rel = "noopener noreferrer";
    sourceLink.style.color = "#0f766e";
    sourceLink.style.fontWeight = "700";
    sourceLink.style.textDecoration = "underline";
    sourceLink.style.wordBreak = "break-all";

    sourceRow.append(sourceLabel, sourceLink);

    const itemField = createField("Item Name", "textarea");
    itemField.input.rows = 2;

    const priceField = createField("Price", "input", "text");
    priceField.input.inputMode = "decimal";

    const itemIdField = createField("Walmart Item ID", "input", "text");
    itemIdField.input.readOnly = true;
    itemIdField.input.style.background = "#fbf7f0";

    const deptField = createField("Department", "input", "text");

    const servingsField = createField("Week Servings", "input", "text");
    servingsField.input.inputMode = "decimal";

    const caloriesField = createField("Calories", "input", "text");
    caloriesField.input.inputMode = "decimal";

    const proteinField = createField("Protein", "input", "text");
    proteinField.input.inputMode = "decimal";

    const fatField = createField("Fat", "input", "text");
    fatField.input.inputMode = "decimal";

    const carbsField = createField("Carbohydrates", "input", "text");
    carbsField.input.inputMode = "decimal";

    const fiberField = createField("Fiber", "input", "text");
    fiberField.input.inputMode = "decimal";

    const urlField = createField("URL", "textarea");
    urlField.input.rows = 2;

    const makeRow = (...fields) => {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "1fr 1fr";
      row.style.gap = "10px";
      row.style.marginBottom = "10px";
      fields.forEach((field) => row.appendChild(field.field));
      return row;
    };

    itemField.field.style.marginBottom = "10px";
    deptField.field.style.marginBottom = "10px";
    urlField.field.style.marginBottom = "10px";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Add To Database";
    save.style.flex = "1";
    save.style.border = "0";
    save.style.borderRadius = "10px";
    save.style.padding = "10px 12px";
    save.style.background = "#0f766e";
    save.style.color = "#ffffff";
    save.style.fontWeight = "700";
    save.style.cursor = "pointer";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Refresh";
    refresh.style.border = "1px solid #cbd5e1";
    refresh.style.borderRadius = "10px";
    refresh.style.padding = "10px 12px";
    refresh.style.background = "#ffffff";
    refresh.style.color = "#334155";
    refresh.style.cursor = "pointer";

    actions.append(save, refresh);
    header.append(title, close);
    panel.append(
      header,
      status,
      sourceRow,
      itemField.field,
      makeRow(priceField, itemIdField),
      deptField.field,
      makeRow(servingsField, caloriesField),
      makeRow(proteinField, fatField),
      makeRow(carbsField, fiberField),
      urlField.field,
      actions
    );
    document.documentElement.appendChild(launcher);
    document.documentElement.appendChild(panel);

    panelElements = {
      launcher,
      panel,
      status,
      sourceRow,
      sourceLink,
      item: itemField.input,
      price: priceField.input,
      itemId: itemIdField.input,
      dept: deptField.input,
      servings: servingsField.input,
      calories: caloriesField.input,
      protein: proteinField.input,
      fat: fatField.input,
      carbs: carbsField.input,
      fiber: fiberField.input,
      url: urlField.input,
      close,
      save,
      refresh,
      isOpen: false
    };

    launcher.addEventListener("click", () => {
      setPanelOpen(true);
      runRefreshSequence();
    });

    close.addEventListener("click", () => {
      setPanelOpen(false);
    });

    return panelElements;
  }

  function renderPanelData(data, lastDepartment) {
    if (!panelElements) {
      return;
    }

    const nutrition = data?.nutrition || getEmptyNutrition();
    panelElements.item.value = data?.title || "";
    panelElements.price.value = data?.price || "";
    panelElements.itemId.value = data?.itemId || "";
    panelElements.dept.value = data?.department || lastDepartment || "";
    panelElements.servings.value = DEFAULT_WEEK_SERVINGS;
    panelElements.calories.value = nutrition.calories || "";
    panelElements.protein.value = nutrition.protein || "";
    panelElements.fat.value = nutrition.fat || "";
    panelElements.carbs.value = nutrition.carbs || "";
    panelElements.fiber.value = nutrition.fiber || "";
    panelElements.url.value = data?.url || location.href;
    setNutritionSource(data?.nutritionSource || null);
  }

  function normalizeOptionalNumber(value, label, decimalPlaces) {
    const raw = String(value || "").trim();
    if (raw === "") {
      return "";
    }

    const match = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!match) {
      throw new Error(`${label} must be numeric.`);
    }

    const number = Number(match[0]);
    if (!Number.isFinite(number)) {
      throw new Error(`${label} must be numeric.`);
    }

    return typeof decimalPlaces === "number" ? number.toFixed(decimalPlaces) : String(number);
  }

  function readPanelForm() {
    const item = String(panelElements.item.value || "").trim();
    if (!item) {
      throw new Error("Item name is required.");
    }

    const price = normalizeOptionalNumber(panelElements.price.value, "Price", 2);
    if (!price) {
      throw new Error("Price is required.");
    }

    return {
      item,
      price,
      dept: String(panelElements.dept.value || "").trim(),
      servings: normalizeOptionalNumber(panelElements.servings.value, "Servings"),
      protein: normalizeOptionalNumber(panelElements.protein.value, "Protein"),
      fat: normalizeOptionalNumber(panelElements.fat.value, "Fat"),
      carbs: normalizeOptionalNumber(panelElements.carbs.value, "Carbohydrates"),
      calories: normalizeOptionalNumber(panelElements.calories.value, "Calories"),
      fiber: normalizeOptionalNumber(panelElements.fiber.value, "Fiber"),
      url: String(panelElements.url.value || location.href).trim()
    };
  }

  async function refreshInjectedPanel() {
    if (location.hostname !== "www.walmart.com") {
      return;
    }

    createPanel();
    setPanelStatus("Reading Walmart page...", "neutral");

    const stored = await getStoredData();
    let data;

    try {
      data = await fetchPageDataFromUrl(location.href);
      const liveDepartment = extractDepartmentFromDom(document);
      if (liveDepartment) {
        data.department = liveDepartment;
      }
    } catch (error) {
      data = await extractPageData();
    }

    data.nutritionSource = hasNutritionValues(data?.nutrition)
      ? {
          label: "Walmart",
          url: data?.url || location.href
        }
      : null;

    renderPanelData(data, stored[LAST_DEPARTMENT_KEY]);

    if (data?.price) {
      setPanelStatus(`Detected ${data.price} from ${data.source}.`, "good");
    } else {
      setPanelStatus("Waiting for Walmart product data on this page.", "neutral");
    }

    if (getMissingNutritionFields(data.nutrition).length === 0) {
      return;
    }

    setPanelStatus("Looking up nutrition from Open Food Facts...", "neutral");
    const fallback = await lookupFallbackNutrition(data);
    if (!fallback || !fallback.nutrition) {
      if (data?.price) {
        setPanelStatus(`Detected ${data.price} from ${data.source}. Nutrition fallback not found.`, "neutral");
      } else {
        setPanelStatus("Could not find nutrition from Walmart or Open Food Facts.", "bad");
      }
      return;
    }

    data.nutrition = mergeNutrition(data.nutrition, fallback.nutrition);
    data.nutritionSource = {
      label: fallback.source,
      url: fallback.sourceUrl || data?.url || location.href
    };
    renderPanelData(data, stored[LAST_DEPARTMENT_KEY]);

    const matchedName = fallback.matchedName ? ` (${fallback.matchedName})` : "";
    setPanelStatus(`Filled nutrition from ${fallback.source}${matchedName}.`, "good");
  }

  async function submitFromPanel() {
    createPanel();
    setPanelBusy(true);
    setPanelStatus("Submitting item to the server...", "neutral");

    try {
      const stored = await getStoredData();
      const form = readPanelForm();
      const result = await submitFoodInsert(form, stored[SETTINGS_KEY]);

      if (form.dept) {
        await browserApi.storage.local.set({
          [LAST_DEPARTMENT_KEY]: form.dept
        });
      }

      const insertedId = result?.insert_id ? ` as ID ${result.insert_id}` : "";
      setPanelStatus(`Added ${form.item}${insertedId}.`, "good");
      setLauncherLabel("Added");
      setPanelOpen(false);
      window.setTimeout(() => {
        setLauncherLabel("Food Import");
      }, 1800);
    } catch (error) {
      setPanelStatus(error.message || String(error), "bad");
    } finally {
      setPanelBusy(false);
    }
  }

  function installWalmartImportPanel() {
    if (location.hostname !== "www.walmart.com") {
      return;
    }

    createPanel();
    if (!panelElements) {
      return;
    }

    panelElements.save.addEventListener("click", () => {
      submitFromPanel().catch(() => {});
    });

    panelElements.refresh.addEventListener("click", () => {
      runRefreshSequence();
    });

    window.setInterval(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        runRefreshSequence();
      }
    }, 1500);
  }

  installWalmartImportPanel();

  browserApi.runtime.onMessage.addListener((message) => {
    if (message?.type !== "getWalmartItemData") {
      return undefined;
    }

    return extractPageData().then((data) => ({
      ok: true,
      ...data
    }));
  });
})();
