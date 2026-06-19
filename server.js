require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const googleTrends = require('google-trends-api');

const app = express();
const PORT = process.env.PORT || 3000;

// eBay credentials
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

// DeepSeek AI
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname)));

// ═══════════════════════════════════════════════════════════════════════
// ── OAuth2 Token Management (with mutex & auto-refresh) ────────────
// ═══════════════════════════════════════════════════════════════════════
let cachedToken = null;
let tokenExpiry = 0;
let tokenPromise = null; // mutex: prevents duplicate token requests

async function getAccessToken(forceRefresh = false) {
    // Return cached token if still valid (with 60-second safety buffer)
    if (!forceRefresh && cachedToken && Date.now() < tokenExpiry - 60000) {
        return cachedToken;
    }

    // If another request is already fetching a token, wait for it
    if (tokenPromise) {
        return tokenPromise;
    }

    tokenPromise = (async () => {
        try {
            const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

            const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${credentials}`
                },
                body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ Token error: ${response.status}`, errorText);
                // Invalidate cache on auth failure
                cachedToken = null;
                tokenExpiry = 0;
                throw new Error(`eBay OAuth failed (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            cachedToken = data.access_token;
            // Set expiry with a 5-minute early buffer so we refresh before it actually expires
            tokenExpiry = Date.now() + (data.expires_in * 1000);

            console.log(`✅ eBay OAuth token acquired, expires in ${data.expires_in}s`);
            return cachedToken;

        } catch (err) {
            // Clear cache on any failure
            cachedToken = null;
            tokenExpiry = 0;
            throw err;
        } finally {
            tokenPromise = null;
        }
    })();

    return tokenPromise;
}

// ═══════════════════════════════════════════════════════════════════════
// ── Robust Fetch with Retry, Timeout & Token Refresh ───────────────
// ═══════════════════════════════════════════════════════════════════════

/**
 * Makes a fetch request to eBay API with:
 * - Automatic retry on transient errors (429, 500, 502, 503, 504)
 * - Exponential backoff between retries
 * - Auto token refresh on 401 Unauthorized
 * - Request timeout (default 20s)
 * - Proper error logging
 */
async function ebayFetch(url, options = {}, retryConfig = {}) {
    const {
        maxRetries = 3,
        baseDelay = 1000,   // 1 second initial delay
        maxDelay = 10000,   // 10 seconds max delay
        timeout = 20000     // 20 second timeout
    } = retryConfig;

    const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Get a fresh token for each attempt (will use cache if valid)
            const token = await getAccessToken(attempt > 0); // force refresh on retry

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const marketplace = options.marketplace || 'EBAY_US';

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-EBAY-C-MARKETPLACE-ID': marketplace,
                    'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ePNCampaignId>,affiliateReferenceId=<referenceId>',
                    'Accept': 'application/json',
                    'Accept-Language': 'en-US',
                    ...options.headers
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // ── Handle 401: token expired mid-request ──
            if (response.status === 401 && attempt < maxRetries) {
                console.warn(`⚠️ Token expired (401), refreshing... (attempt ${attempt + 1}/${maxRetries})`);
                cachedToken = null;
                tokenExpiry = 0;
                await sleep(500);
                continue;
            }

            // ── Handle retryable server errors ──
            if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
                const retryAfter = response.headers.get('retry-after');
                const delay = retryAfter
                    ? parseInt(retryAfter) * 1000
                    : Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

                console.warn(`⚠️ eBay API ${response.status}, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
                await sleep(delay);
                continue;
            }

            // ── Handle non-retryable errors ──
            if (!response.ok) {
                const errBody = await response.text().catch(() => '(no body)');
                throw new Error(`eBay API error ${response.status}: ${errBody}`);
            }

            return await response.json();

        } catch (err) {
            // Handle timeout (AbortError)
            if (err.name === 'AbortError') {
                if (attempt < maxRetries) {
                    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
                    console.warn(`⚠️ Request timeout, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
                    await sleep(delay);
                    continue;
                }
                throw new Error(`eBay API request timed out after ${maxRetries + 1} attempts`);
            }

            // Handle network errors (DNS, connection refused, etc.)
            if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
                if (attempt < maxRetries) {
                    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
                    console.warn(`⚠️ Network error: ${err.message}, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
                    await sleep(delay);
                    continue;
                }
            }

            throw err;
        }
    }

    throw new Error('eBay API request failed after all retry attempts');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════
// ── eBay Browse API Search (single page) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════
async function searchEbay(query, options = {}) {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('limit', options.limit || '50');

    // Build filters
    const filters = buildFilters(options);
    if (filters.length > 0) {
        params.set('filter', filters.join(','));
    }

    const marketplace = getMarketplace(options.location);
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`;
    console.log(`🔍 Searching eBay: ${url}`);

    return await ebayFetch(url, { marketplace });
}

// ═══════════════════════════════════════════════════════════════════════
// ── eBay Multi-Page Fetch (paginated, with rate-limit protection) ──
// ═══════════════════════════════════════════════════════════════════════
async function searchEbayMultiPage(query, options = {}, maxPages = 3) {
    const allItems = [];
    const limit = 50;
    const marketplace = getMarketplace(options.location);
    const filters = buildFilters(options);

    for (let page = 0; page < maxPages; page++) {
        const offset = page * limit;

        const params = new URLSearchParams();
        params.set('q', query);
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        if (filters.length > 0) {
            params.set('filter', filters.join(','));
        }

        const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`;

        try {
            console.log(`📄 Fetching page ${page + 1}/${maxPages}: offset=${offset}`);

            const data = await ebayFetch(url, { marketplace });

            if (!data.itemSummaries || data.itemSummaries.length === 0) {
                console.log(`   ↳ Page ${page + 1}: no more items, stopping pagination`);
                break;
            }

            allItems.push(...data.itemSummaries);
            console.log(`   ↳ Page ${page + 1}: got ${data.itemSummaries.length} items (total: ${allItems.length})`);

            // If we got fewer items than the limit, there are no more pages
            if (data.itemSummaries.length < limit) break;

            // Rate-limit protection: delay between pages (increases with each page)
            if (page < maxPages - 1) {
                const delay = 400 + (page * 200); // 400ms, 600ms, etc.
                await sleep(delay);
            }

        } catch (err) {
            console.error(`❌ Page ${page + 1} failed: ${err.message}`);

            // If first page fails, throw to notify frontend — the query itself might be broken
            if (page === 0) {
                throw new Error(`Gagal mengambil data dari eBay: ${err.message}`);
            }

            // For subsequent pages, log and continue with what we have
            console.warn(`   ↳ Continuing with ${allItems.length} items collected so far`);
            break;
        }
    }

    return allItems;
}

// ═══════════════════════════════════════════════════════════════════════
// ── Helper: Build eBay Filter Strings ──────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
function buildFilters(options = {}) {
    const filters = [];

    if (options.condition && options.condition !== 'all') {
        const conditionMap = {
            'new': '1000',
            'used': '3000',
            'refurbished': '2000',
            'parts': '7000'
        };
        const mapped = conditionMap[options.condition];
        if (mapped) {
            filters.push(`conditionIds:{${mapped}}`);
        }
    }

    if (options.buyingOptions) {
        filters.push(`buyingOptions:{${options.buyingOptions}}`);
    }

    return filters;
}

// ═══════════════════════════════════════════════════════════════════════
// ── Helper: Marketplace ID Mapping ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
function getMarketplace(location) {
    const map = {
        'us': 'EBAY_US',
        'uk': 'EBAY_GB',
        'de': 'EBAY_DE',
        'au': 'EBAY_AU',
        'fr': 'EBAY_FR',
        'it': 'EBAY_IT',
        'es': 'EBAY_ES',
        'ca': 'EBAY_CA',
        'global': 'EBAY_US'
    };
    return map[location] || 'EBAY_US';
}

// ═══════════════════════════════════════════════════════════════════════
// ── Analytics Processing ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
function processAnalytics(items, query) {
    if (!items || items.length === 0) {
        return { error: 'No items found', totalItems: 0 };
    }

    // Extract prices (USD)
    const prices = items
        .filter(item => item.price && item.price.value)
        .map(item => parseFloat(item.price.value));

    // Price statistics
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const medianPrice = sortedPrices.length % 2 === 0
        ? (sortedPrices[sortedPrices.length / 2 - 1] + sortedPrices[sortedPrices.length / 2]) / 2
        : sortedPrices[Math.floor(sortedPrices.length / 2)];
    const minPrice = sortedPrices[0] || 0;
    const maxPrice = sortedPrices[sortedPrices.length - 1] || 0;

    // Price distribution (histogram)
    const priceRange = maxPrice - minPrice;
    const bucketCount = 6;
    const bucketSize = priceRange / bucketCount || 1;
    const priceBuckets = [];
    for (let i = 0; i < bucketCount; i++) {
        const low = minPrice + (i * bucketSize);
        const high = minPrice + ((i + 1) * bucketSize);
        const count = prices.filter(p => p >= low && (i === bucketCount - 1 ? p <= high : p < high)).length;
        priceBuckets.push({
            label: `$${Math.round(low)} - $${Math.round(high)}`,
            count: count,
            low: Math.round(low),
            high: Math.round(high)
        });
    }

    // Condition distribution
    const conditionCounts = {};
    items.forEach(item => {
        const condition = item.condition || 'Unknown';
        conditionCounts[condition] = (conditionCounts[condition] || 0) + 1;
    });

    // Buying options (BIN vs Auction)
    let binCount = 0;
    let auctionCount = 0;
    items.forEach(item => {
        if (item.buyingOptions) {
            if (item.buyingOptions.includes('FIXED_PRICE') || item.buyingOptions.includes('BEST_OFFER')) {
                binCount++;
            }
            if (item.buyingOptions.includes('AUCTION')) {
                auctionCount++;
            }
        }
    });
    const totalListingTypes = binCount + auctionCount || 1;
    const binPercentage = Math.round((binCount / totalListingTypes) * 100);

    // Seller analysis (market share)
    const sellerCounts = {};
    items.forEach(item => {
        if (item.seller && item.seller.username) {
            const seller = item.seller.username;
            sellerCounts[seller] = (sellerCounts[seller] || 0) + 1;
        }
    });
    const sortedSellers = Object.entries(sellerCounts)
        .sort((a, b) => b[1] - a[1]);
    const topSellers = sortedSellers.slice(0, 5).map(([name, count]) => ({
        name,
        count,
        percentage: Math.round((count / items.length) * 100)
    }));
    const othersCount = items.length - topSellers.reduce((sum, s) => sum + s.count, 0);
    const uniqueSellers = Object.keys(sellerCounts).length;

    // Geographic distribution
    const locationCounts = {};
    items.forEach(item => {
        if (item.itemLocation) {
            const country = item.itemLocation.country || 'Unknown';
            const region = item.itemLocation.stateOrProvince || item.itemLocation.city || country;
            const key = `${region}, ${country}`;
            locationCounts[key] = (locationCounts[key] || 0) + 1;
        }
    });
    const topLocations = Object.entries(locationCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([region, count]) => ({
            region,
            count,
            percentage: Math.round((count / items.length) * 100)
        }));

    // Keywords from titles
    const wordFreq = {};
    const stopWords = new Set(['for', 'the', 'and', 'with', 'fit', 'fits', 'new', 'used', 'a', 'an', 'in', 'on', 'to', 'of', '-', '&', '/', '|']);
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    items.forEach(item => {
        if (item.title) {
            const words = item.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
            words.forEach(w => {
                if (w.length > 2 && !stopWords.has(w) && !queryWords.has(w)) {
                    wordFreq[w] = (wordFreq[w] || 0) + 1;
                }
            });
        }
    });
    const topKeywords = Object.entries(wordFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({ word, count }));

    // Variant analysis from titles
    const variantFreq = {};
    items.forEach(item => {
        if (item.title) {
            const variantPatterns = [
                /\b(full system|slip[- ]?on|header|cat[- ]?back|axle[- ]?back|mid pipe)\b/gi,
                /\b(carbon|titanium|stainless|steel|aluminum|black|silver|gold|chrome)\b/gi,
                /\b(pro|race|sport|street|touring|performance)\b/gi
            ];
            variantPatterns.forEach(pattern => {
                const matches = item.title.match(pattern);
                if (matches) {
                    matches.forEach(m => {
                        const key = m.trim().toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
                        variantFreq[key] = (variantFreq[key] || 0) + 1;
                    });
                }
            });
        }
    });
    const topVariants = Object.entries(variantFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, count]) => ({ name, count }));

    // Calculate entry barrier score (0-100)
    const sellerDiversity = Math.min(uniqueSellers / items.length, 1);
    const entryBarrier = Math.round(
        50 +
        (sellerDiversity < 0.3 ? 30 : sellerDiversity < 0.6 ? 15 : 0) -
        (uniqueSellers > 20 ? 20 : 0)
    );

    // Optimal price recommendation (median + small margin)
    const optimalPrice = medianPrice * 1.05;

    // Calculate price vs average
    const priceVsAvg = ((optimalPrice - avgPrice) / avgPrice * 100).toFixed(1);

    // Sample items (top 30 by relevance)
    const sampleItems = items.slice(0, 30).map(item => ({
        title: item.title,
        price: item.price ? `${item.price.currency} ${item.price.value}` : 'N/A',
        condition: item.condition || 'N/A',
        location: item.itemLocation ? `${item.itemLocation.country || ''}` : 'N/A',
        image: item.image ? item.image.imageUrl : null,
        link: item.itemWebUrl || null,
        buyingOptions: item.buyingOptions || [],
        seller: item.seller ? item.seller.username : 'N/A'
    }));

    return {
        totalItems: items.length,
        currency: items[0]?.price?.currency || 'USD',
        timestamp: new Date().toISOString(),

        pricing: {
            avg: Math.round(avgPrice * 100) / 100,
            median: Math.round(medianPrice * 100) / 100,
            min: Math.round(minPrice * 100) / 100,
            max: Math.round(maxPrice * 100) / 100,
            optimal: Math.round(optimalPrice * 100) / 100,
            priceVsAvg: priceVsAvg,
            distribution: priceBuckets
        },

        conditions: conditionCounts,

        buyingOptions: {
            bin: binCount,
            auction: auctionCount,
            binPercentage: binPercentage
        },

        sellers: {
            unique: uniqueSellers,
            top: topSellers,
            othersCount: othersCount,
            othersPercentage: Math.round((othersCount / items.length) * 100)
        },

        geography: topLocations,

        keywords: topKeywords,

        variants: topVariants,

        entryBarrier: Math.min(Math.max(entryBarrier, 10), 95),

        sampleItems: sampleItems
    };
}

// ═══════════════════════════════════════════════════════════════════════
// ── DeepSeek AI Analysis ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
async function generateAIAnalysis(analytics, query) {
    if (!DEEPSEEK_API_KEY) {
        console.warn('⚠️ DeepSeek API key not configured, skipping AI analysis');
        return null;
    }

    const sym = analytics.currency === 'USD' ? '$' : analytics.currency === 'GBP' ? '£' : '€';

    // Build a concise data summary for the AI
    const dataSummary = `
PRODUK: "${query}"
TOTAL LISTING: ${analytics.totalItems}
MATAUANG: ${analytics.currency}

HARGA:
- Rata-rata: ${sym}${analytics.pricing.avg}
- Median: ${sym}${analytics.pricing.median}
- Min: ${sym}${analytics.pricing.min}
- Max: ${sym}${analytics.pricing.max}
- Distribusi: ${analytics.pricing.distribution.map(b => `${b.label}: ${b.count} listing`).join(', ')}

KONDISI: ${Object.entries(analytics.conditions).map(([k, v]) => `${k}: ${v}`).join(', ')}

TIPE LISTING:
- Buy It Now: ${analytics.buyingOptions.bin} (${analytics.buyingOptions.binPercentage}%)
- Auction: ${analytics.buyingOptions.auction}

PENJUAL:
- Total unik: ${analytics.sellers.unique}
- Top sellers: ${analytics.sellers.top.map(s => `${s.name} (${s.count} listing, ${s.percentage}%)`).join(', ')}

LOKASI: ${analytics.geography.map(g => `${g.region}: ${g.percentage}%`).join(', ')}

KEYWORDS POPULER: ${analytics.keywords.map(k => `"${k.word}" (${k.count}x)`).join(', ')}

VARIAN: ${analytics.variants.map(v => `${v.name} (${v.count})`).join(', ')}
`;

    const systemPrompt = `Kamu adalah AI Market Intelligence Analyst yang sangat ahli di eBay marketplace. Kamu menganalisis data pasar dan memberikan rekomendasi yang actionable untuk penjual.

BAHASA: Gunakan Bahasa Indonesia yang profesional.
FORMAT: Jawab HANYA dalam format JSON valid berikut, tanpa markdown atau teks tambahan:

{
  "optimalPrice": {
    "value": <number>,
    "rationale": "<penjelasan singkat kenapa harga ini optimal>"
  },
  "entryBarrier": {
    "score": <0-100>,
    "level": "Rendah|Sedang|Tinggi",
    "description": "<penjelasan singkat>"
  },
  "strategies": [
    {
      "title": "<judul strategi>",
      "description": "<penjelasan detail dan actionable>"
    }
  ],
  "insights": [
    "<insight berbasis data>"
  ],
  "actionPlan": [
    {
      "day": "Hari X",
      "action": "<aksi spesifik>"
    }
  ],
  "titleSuggestion": "<contoh judul listing optimal untuk SEO eBay>",
  "keywordsToUse": ["<keyword1>", "<keyword2>"],
  "keywordsToAvoid": ["<keyword1>", "<keyword2>"],
  "riskAssessment": "<penilaian risiko singkat>",
  "opportunityScore": <0-100>,
  "seasonalTip": "<tips berdasarkan musim/waktu saat ini>",
  "demandAndTiming": {
    "seasonalityIndex": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "optimalDay": "<hari terbaik untuk listing>",
    "optimalTime": "<rentang waktu terbaik, misal: 19:00 - 21:00>"
  }
}`;

    const userPrompt = `Analisis data pasar eBay berikut dan berikan rekomendasi lengkap:\n${dataSummary}\n\nBerikan 3 strategi utama, 5 insights, dan 5 action plans berdasarkan data di atas. Harga optimal harus berdasarkan analisis distribusi harga dan kompetisi. Hasilkan 'demandAndTiming' dengan estimasi data tren pencarian bulanan (12 bulan, 0.0 - 1.0) dan hari/jam terbaik untuk listing berdasarkan jenis produk ini. Pastikan semua rekomendasi spesifik dan actionable.`;

    console.log('🤖 Requesting DeepSeek AI analysis...');

    // Retry AI analysis up to 2 times
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout for AI

            const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.7,
                    max_tokens: 2000,
                    response_format: { type: 'json_object' }
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errText = await response.text();
                console.error(`DeepSeek API error: ${response.status}`, errText);
                if (attempt === 0) {
                    await sleep(2000);
                    continue;
                }
                return null;
            }

            const result = await response.json();
            const content = result.choices?.[0]?.message?.content;

            if (!content) {
                console.error('DeepSeek returned empty content');
                return null;
            }

            // Parse the JSON response
            const aiData = JSON.parse(content);
            console.log('✅ DeepSeek AI analysis complete');
            return aiData;

        } catch (err) {
            console.error(`DeepSeek AI error (attempt ${attempt + 1}):`, err.message);
            if (attempt === 0) {
                await sleep(2000);
                continue;
            }
            return null;
        }
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════════
// ── API Routes ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// GET /api/search — Raw search results
app.get('/api/search', async (req, res) => {
    try {
        const { q, condition, location, limit } = req.query;
        if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

        const data = await searchEbay(q, { condition, location, limit });
        res.json(data);
    } catch (err) {
        console.error('Search error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/stats — Processed analytics for the dashboard
app.get('/api/stats', async (req, res) => {
    try {
        const { q, condition, location } = req.query;
        if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`📊 NEW ANALYSIS: "${q}" (condition: ${condition || 'all'}, location: ${location || 'global'})`);
        console.log(`${'═'.repeat(60)}`);

        // Fetch multiple pages for better analytics
        const items = await searchEbayMultiPage(q, { condition, location }, 3);

        if (!items || items.length === 0) {
            return res.json({ error: 'No items found', totalItems: 0 });
        }

        const analytics = processAnalytics(items, q);

        // Run AI analysis (with graceful fallback)
        let aiAnalysis = null;
        try {
            aiAnalysis = await generateAIAnalysis(analytics, q);
        } catch (aiErr) {
            console.warn('⚠️ AI analysis failed, continuing with data-only results:', aiErr.message);
        }

        // Merge AI analysis into response
        analytics.ai = aiAnalysis;

        // Fetch Google Trends Demand
        let googleTrendsDemand = [];
        try {
            console.log('📈 Fetching Google Trends demand...');
            const trendsRes = await googleTrends.interestByRegion({ keyword: q, resolution: 'COUNTRY' });
            const trendsData = JSON.parse(trendsRes);
            if (trendsData && trendsData.default && trendsData.default.geoMapData) {
                googleTrendsDemand = trendsData.default.geoMapData
                    .filter(geo => geo.hasData && geo.value[0] > 0)
                    .sort((a, b) => b.value[0] - a.value[0])
                    .slice(0, 5)
                    .map(geo => ({
                        region: geo.geoName,
                        percentage: geo.value[0]
                    }));
                
                const totalScore = googleTrendsDemand.reduce((sum, item) => sum + item.percentage, 0);
                if (totalScore > 0) {
                    googleTrendsDemand = googleTrendsDemand.map(item => ({
                        region: item.region,
                        percentage: Math.round((item.percentage / totalScore) * 100)
                    }));
                }
            }
        } catch (trendErr) {
            console.warn('⚠️ Google Trends API failed:', trendErr.message);
        }
        analytics.googleTrends = googleTrendsDemand;

        console.log(`✅ Analytics complete: ${analytics.totalItems} items processed ${aiAnalysis ? '+ AI insights' : '(no AI)'}`);
        console.log(`${'─'.repeat(60)}\n`);

        res.json(analytics);
    } catch (err) {
        console.error('❌ Stats error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/api/health', async (req, res) => {
    let tokenStatus = 'no_token';
    let tokenValid = false;

    if (cachedToken) {
        tokenValid = Date.now() < tokenExpiry;
        tokenStatus = tokenValid ? 'valid' : 'expired';
    }

    // Optionally test eBay connectivity
    let ebayReachable = false;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=test&limit=1', {
            headers: { 'Authorization': `Bearer ${cachedToken || 'invalid'}` },
            signal: controller.signal
        });
        clearTimeout(timeout);
        ebayReachable = resp.status !== 0; // any HTTP response means eBay is reachable
    } catch (e) {
        ebayReachable = false;
    }

    res.json({
        status: 'ok',
        hasCredentials: !!(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET),
        hasAI: !!DEEPSEEK_API_KEY,
        tokenStatus,
        tokenValid,
        ebayReachable,
        uptime: process.uptime()
    });
});

// ═══════════════════════════════════════════════════════════════════════
// ── Start Server ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  🚀 Market Intelligence Server                          ║
║  Running on http://localhost:${PORT}                       ║
║  eBay API: ${EBAY_CLIENT_ID ? '✅ Credentials loaded' : '❌ Missing credentials'}                    ║
║  DeepSeek AI: ${DEEPSEEK_API_KEY ? '✅ API key loaded' : '❌ Missing API key'}                       ║
║                                                          ║
║  Features:                                               ║
║  • Auto-retry on eBay API errors (3 attempts)            ║
║  • Token auto-refresh on 401 Unauthorized                ║
║  • Request timeout protection (20s)                      ║
║  • Rate-limit backoff between paginated requests         ║
║  • Exponential backoff on server errors                  ║
╚══════════════════════════════════════════════════════════╝
    `);
});
