// ── Theme Toggle Logic ──────────────────────────────────────────────
const themeToggleBtn = document.getElementById('theme-toggle');
const body = document.body;

// Check local storage for theme preference
const currentTheme = localStorage.getItem('theme') || 'light-mode';
body.className = currentTheme;

// Set initial icon before lucide processes them
const initialIcon = themeToggleBtn.querySelector('[data-lucide]');
if (initialIcon) {
    initialIcon.setAttribute('data-lucide', currentTheme === 'dark-mode' ? 'sun' : 'moon');
}

// NOW initialize Lucide Icons (replaces <i> with <svg>)
lucide.createIcons();

themeToggleBtn.addEventListener('click', () => {
    if (body.classList.contains('light-mode')) {
        body.classList.replace('light-mode', 'dark-mode');
        localStorage.setItem('theme', 'dark-mode');
        updateThemeIcon('dark-mode');
    } else {
        body.classList.replace('dark-mode', 'light-mode');
        localStorage.setItem('theme', 'light-mode');
        updateThemeIcon('light-mode');
    }
    // Re-render charts to update colors
    updateChartColors();
});

function updateThemeIcon(theme) {
    // After lucide init, icons are <svg>, so we need to replace the svg inside the button
    const oldIcon = themeToggleBtn.querySelector('svg, [data-lucide]');
    if (oldIcon) {
        // Create a fresh <i> element for lucide to process
        const newIcon = document.createElement('i');
        newIcon.setAttribute('data-lucide', theme === 'dark-mode' ? 'sun' : 'moon');
        oldIcon.replaceWith(newIcon);
        lucide.createIcons();
    }
}

// ── Chart.js Configuration ──────────────────────────────────────────
Chart.defaults.font.family = "'Inter', sans-serif";

let pricingChart, competitionChart, variantChart;
let lastAnalyticsData = null;

function getChartColors() {
    const isDark = body.classList.contains('dark-mode');
    return {
        textColor: isDark ? '#adb5bd' : '#5c5f66',
        gridColor: isDark ? '#2c2e33' : '#e9ecef',
        primaryColor: isDark ? '#f8f9fa' : '#121212',
        accentPositive: isDark ? '#69db7c' : '#2b8a3e',
        accentNegative: isDark ? '#ff8787' : '#c92a2a',
        bgTertiary: isDark ? '#2c2e33' : '#e9ecef',
        shades: isDark
            ? ['#f8f9fa', '#adb5bd', '#868e96', '#6c757d', '#495057', '#2c2e33']
            : ['#121212', '#343a40', '#495057', '#6c757d', '#868e96', '#adb5bd']
    };
}

// ── Loading State Management ────────────────────────────────────────
const loadingOverlay = document.getElementById('loading-overlay');
const analyzeBtn = document.getElementById('analyze-btn');

function showLoading(query) {
    loadingOverlay.classList.add('active');
    analyzeBtn.classList.add('loading');
    analyzeBtn.disabled = true;
    document.getElementById('loading-query').textContent = `Mencari "${query}" di eBay...`;

    // Animate loading steps
    const steps = ['step-auth', 'step-fetch', 'step-analyze', 'step-ai'];
    steps.forEach(s => {
        document.getElementById(s).classList.remove('active', 'done');
    });

    setTimeout(() => document.getElementById('step-auth').classList.add('active'), 200);
    setTimeout(() => {
        document.getElementById('step-auth').classList.remove('active');
        document.getElementById('step-auth').classList.add('done');
        document.getElementById('step-fetch').classList.add('active');
    }, 800);
    setTimeout(() => {
        document.getElementById('step-fetch').classList.remove('active');
        document.getElementById('step-fetch').classList.add('done');
        document.getElementById('step-analyze').classList.add('active');
    }, 2000);
    setTimeout(() => {
        document.getElementById('step-analyze').classList.remove('active');
        document.getElementById('step-analyze').classList.add('done');
        document.getElementById('step-ai').classList.add('active');
    }, 3000);
}

function hideLoading() {
    // Mark last step done
    document.getElementById('step-ai').classList.remove('active');
    document.getElementById('step-ai').classList.add('done');

    setTimeout(() => {
        loadingOverlay.classList.remove('active');
        analyzeBtn.classList.remove('loading');
        analyzeBtn.disabled = false;
    }, 400);
}

function showError(message) {
    const toast = document.getElementById('error-toast');
    document.getElementById('error-message').textContent = message;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 5000);
}

// ── API Integration ─────────────────────────────────────────────────
// Detect the correct backend URL: if opened via file:// or a different dev server,
// always connect to the Express backend on port 3000
const API_BASE = (function() {
    const origin = window.location.origin;
    // If opened via file:// protocol, origin is "null" or "file://"
    if (!origin || origin === 'null' || origin.startsWith('file:')) {
        return 'http://127.0.0.1:3000';
    }
    // If opened via a different dev server (e.g., VS Code Live Server on 5500)
    const port = window.location.port;
    if (port && port !== '3000') {
        return 'http://127.0.0.1:3000';
    }
    return origin;
})();

async function fetchAnalytics(query, condition, location) {
    const params = new URLSearchParams({ q: query });
    if (condition && condition !== 'all') params.set('condition', condition);
    if (location) params.set('location', location);

    const url = `${API_BASE}/api/stats?${params.toString()}`;
    const maxRetries = 2;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);

            if (!response.ok) {
                const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                const errMsg = err.error || `HTTP ${response.status}`;

                // Retry on server errors
                if (response.status >= 500 && attempt < maxRetries - 1) {
                    console.warn(`Server error (${response.status}), retrying in 2s...`);
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }

                throw new Error(errMsg);
            }

            return await response.json();

        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('Koneksi timeout. Server eBay mungkin sedang lambat, coba lagi.');
            }

            // Retry on network errors
            if (attempt < maxRetries - 1 && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))) {
                console.warn(`Network error, retrying in 2s...`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            throw err;
        }
    }
}

// ── Main Analysis Trigger ───────────────────────────────────────────
async function runAnalysis() {
    const query = document.getElementById('search-input').value.trim();
    if (!query) {
        showError('Masukkan nama produk untuk dianalisis');
        return;
    }

    const condition = document.getElementById('condition-filter').value;
    const location = document.getElementById('location-filter').value;

    showLoading(query);

    try {
        const data = await fetchAnalytics(query, condition, location);

        if (data.error || data.totalItems === 0) {
            hideLoading();
            showError(data.error || 'Tidak ada produk ditemukan. Coba kata kunci lain.');
            return;
        }

        lastAnalyticsData = data;
        updateDashboard(data, query, location);
        hideLoading();

        // Show live badge
        document.getElementById('live-badge').classList.add('visible');

    } catch (err) {
        console.error('Analysis error:', err);
        hideLoading();
        showError(`Gagal mengambil data: ${err.message}`);
    }
}

// ── Update Dashboard with Real Data ─────────────────────────────────
function updateDashboard(data, query, location) {
    const currency = data.currency || 'USD';
    const sym = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€';

    // 1. Data Meta Bar
    const metaBar = document.getElementById('data-meta-bar');
    document.getElementById('meta-total').textContent = data.totalItems + ' items';
    const marketplaceNames = { 'us': 'eBay US', 'uk': 'eBay UK', 'de': 'eBay DE', 'au': 'eBay AU', 'global': 'eBay US (Global)' };
    document.getElementById('meta-marketplace').textContent = marketplaceNames[location] || 'eBay US';
    document.getElementById('meta-timestamp').textContent = new Date(data.timestamp).toLocaleString('id-ID');
    metaBar.classList.add('visible');

    // 2. Optimal Price — prefer AI price if available
    if (data.ai && data.ai.optimalPrice) {
        document.getElementById('optimal-price').textContent = `${sym} ${formatNumber(data.ai.optimalPrice.value)}`;
        document.getElementById('price-range-info').textContent = data.ai.optimalPrice.rationale;
        const aiPriceVsAvg = ((data.ai.optimalPrice.value - data.pricing.avg) / data.pricing.avg * 100).toFixed(1);
        const priceVsEl = document.getElementById('price-vs-avg');
        if (parseFloat(aiPriceVsAvg) >= 0) {
            priceVsEl.className = 'positive';
            priceVsEl.innerHTML = `<i data-lucide="trending-up" size="14"></i> +${aiPriceVsAvg}% di atas rata-rata`;
        } else {
            priceVsEl.className = 'negative';
            priceVsEl.innerHTML = `<i data-lucide="trending-down" size="14"></i> ${aiPriceVsAvg}% di bawah rata-rata`;
        }
    } else {
        document.getElementById('optimal-price').textContent = `${sym} ${formatNumber(data.pricing.optimal)}`;
        const priceVsAvg = parseFloat(data.pricing.priceVsAvg);
        const priceVsEl = document.getElementById('price-vs-avg');
        if (priceVsAvg >= 0) {
            priceVsEl.className = 'positive';
            priceVsEl.innerHTML = `<i data-lucide="trending-up" size="14"></i> +${priceVsAvg}% di atas rata-rata`;
        } else {
            priceVsEl.className = 'negative';
            priceVsEl.innerHTML = `<i data-lucide="trending-down" size="14"></i> ${priceVsAvg}% di bawah rata-rata`;
        }
        document.getElementById('price-range-info').textContent =
            `Range: ${sym}${formatNumber(data.pricing.min)} — ${sym}${formatNumber(data.pricing.max)}`;
    }

    // 3. Entry Barrier — prefer AI barrier if available
    const barrierGauge = document.getElementById('barrier-gauge');
    const barrierScoreEl = document.getElementById('barrier-score-value');
    const barrierBadge = document.getElementById('barrier-level-badge');
    const barrierDesc = document.getElementById('barrier-desc');

    if (data.ai && data.ai.entryBarrier) {
        const barrier = data.ai.entryBarrier.score;
        const level = data.ai.entryBarrier.level.toLowerCase();
        barrierGauge.style.setProperty('--value', barrier);
        barrierGauge.setAttribute('data-level', level);
        barrierScoreEl.textContent = barrier;
        barrierBadge.textContent = data.ai.entryBarrier.level;
        barrierBadge.setAttribute('data-level', level);
        barrierDesc.textContent = data.ai.entryBarrier.description;
    } else {
        const barrier = data.entryBarrier;
        const level = barrier > 70 ? 'tinggi' : barrier > 40 ? 'sedang' : 'rendah';
        const levelDisplay = barrier > 70 ? 'High' : barrier > 40 ? 'Medium' : 'Low';
        barrierGauge.style.setProperty('--value', barrier);
        barrierGauge.setAttribute('data-level', level);
        barrierScoreEl.textContent = barrier;
        barrierBadge.textContent = levelDisplay;
        barrierBadge.setAttribute('data-level', level);
        const barrierDescMap = {
            'tinggi': 'Kompetisi ketat. Dibutuhkan strategi diferensiasi agresif.',
            'sedang': 'Kompetisi moderat. Diferensiasi listing yang kuat dapat memberi keunggulan.',
            'rendah': 'Pasar terbuka lebar. Peluang bagus untuk masuk dengan listing berkualitas.'
        };
        barrierDesc.textContent = barrierDescMap[level];
    }

    // 4. Strategy List — prefer AI strategies
    const strategyList = document.getElementById('strategy-list');
    if (data.ai && data.ai.strategies && data.ai.strategies.length > 0) {
        strategyList.innerHTML = data.ai.strategies.slice(0, 3).map(s =>
            `<li><i data-lucide="check-circle-2"></i> <strong>${s.title}:</strong> ${s.description}</li>`
        ).join('');
    } else {
        const strategies = generateStrategies(data, query, sym);
        strategyList.innerHTML = strategies.map(s =>
            `<li><i data-lucide="check-circle-2"></i> <strong>${s.title}:</strong> ${s.desc}</li>`
        ).join('');
    }

    // Show AI badge if AI data is present
    const aiBadge = document.getElementById('ai-badge');
    if (data.ai) {
        aiBadge.style.backgroundColor = 'var(--accent-positive-bg)';
        aiBadge.style.color = 'var(--accent-positive)';
        aiBadge.style.borderColor = 'var(--accent-positive)';
        aiBadge.classList.add('visible');
    }

    // 5. High Impact Focus
    document.getElementById('focus-bin').innerHTML =
        `<i data-lucide="shopping-cart"></i><span>BIN vs Auction: <strong>${data.buyingOptions.binPercentage}% Buy It Now</strong></span>`;
    document.getElementById('focus-sellers').innerHTML =
        `<i data-lucide="users"></i><span>Unique Sellers: <strong>${data.sellers.unique} sellers</strong></span>`;

    // 6. Charts & Heatmap
    updateCharts(data);
    
    // Update Heatmap and Timing with AI data if available
    generateHeatmap(data.ai ? data.ai.demandAndTiming : null);

    // 7. Insights under charts
    document.getElementById('insight-avg-price').textContent = `${sym} ${formatNumber(data.pricing.avg)}`;
    document.getElementById('insight-median-price').textContent = `${sym} ${formatNumber(data.pricing.median)}`;

    // Competition insights
    const top3Share = data.sellers.top.slice(0, 3).reduce((sum, s) => sum + s.percentage, 0);
    const concentrationEl = document.getElementById('insight-market-concentration');
    concentrationEl.textContent = `${top3Share > 50 ? 'High' : 'Medium'} (Top 3 = ${top3Share}%)`;
    concentrationEl.className = `value ${top3Share > 50 ? 'negative' : 'positive'}`;
    document.getElementById('insight-unique-sellers').textContent = `${data.sellers.unique} sellers`;

    // 8. Geographic Supply & Demand
    updateGeography(data.geography);
    if (data.googleTrends) {
        updateDemandGeography(data.googleTrends);
    } else {
        updateDemandGeography([]);
    }

    // 9. Keywords
    updateKeywords(data.keywords, query, data.ai);

    // 10. Product variants
    const conditions = Object.entries(data.conditions);
    if (conditions.length > 0) {
        const dominant = conditions.sort((a, b) => b[1] - a[1])[0];
        document.getElementById('insight-dominant-condition').textContent =
            `${dominant[0]} (${Math.round(dominant[1] / data.totalItems * 100)}%)`;
    }
    if (data.ai && data.ai.dynamicVariants && data.ai.dynamicVariants.length > 0) {
        document.getElementById('insight-top-variant').textContent = data.ai.dynamicVariants[0].name;
    } else if (data.variants.length > 0) {
        document.getElementById('insight-top-variant').textContent = data.variants[0].name;
    } else {
        document.getElementById('insight-top-variant').textContent = '-';
    }

    // 11. Sample Items
    updateSampleItems(data.sampleItems);

    // 12. Strategy & Conclusion
    updateConclusion(data, query, sym);

    // Re-initialize lucide icons for newly created elements
    lucide.createIcons();
}

function formatNumber(num) {
    return Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Generate Strategies Based on Data ───────────────────────────────
function generateStrategies(data, query, sym) {
    const strategies = [];

    // Price strategy
    if (data.pricing.median < data.pricing.avg) {
        strategies.push({
            title: 'Price Kompetitif',
            desc: `Price median (${sym}${formatNumber(data.pricing.median)}) lebih rendah dari rata-rata. Listing di ${sym}${formatNumber(data.pricing.optimal)} memberikan margin optimal.`
        });
    } else {
        strategies.push({
            title: 'Premium Pricing',
            desc: `Pasar mendukung harga tinggi. Target ${sym}${formatNumber(data.pricing.optimal)} untuk margin terbaik.`
        });
    }

    // BIN vs Auction
    if (data.buyingOptions.binPercentage > 70) {
        strategies.push({
            title: 'Gunakan Buy It Now',
            desc: `${data.buyingOptions.binPercentage}% listing menggunakan BIN. Pembeli di pasar ini lebih suka harga tetap.`
        });
    } else {
        strategies.push({
            title: 'Coba Auction + BIN',
            desc: `Hanya ${data.buyingOptions.binPercentage}% yang BIN. Auction bisa mendorong harga lebih tinggi melalui bid war.`
        });
    }

    // Competition strategy
    if (data.sellers.unique < 10) {
        strategies.push({
            title: 'Pasar Niche',
            desc: `Hanya ${data.sellers.unique} sellers aktif. Kesempatan untuk mendominasi dengan listing berkualitas tinggi.`
        });
    } else {
        strategies.push({
            title: 'Diferensiasi',
            desc: `${data.sellers.unique} sellers aktif. Fokus pada foto HD, deskripsi detail, dan free shipping untuk menonjol.`
        });
    }

    return strategies.slice(0, 3);
}

// ── Update Charts ───────────────────────────────────────────────────
function updateCharts(data) {
    if (pricingChart) pricingChart.destroy();
    if (competitionChart) competitionChart.destroy();
    if (variantChart) variantChart.destroy();

    const c = getChartColors();

    // 1. Pricing Distribution (Bar Chart)
    const ctxPricing = document.getElementById('pricingChart').getContext('2d');
    pricingChart = new Chart(ctxPricing, {
        type: 'bar',
        data: {
            labels: data.pricing.distribution.map(b => b.label),
            datasets: [{
                label: 'Count Listing',
                data: data.pricing.distribution.map(b => b.count),
                backgroundColor: c.primaryColor,
                borderRadius: 4,
                barThickness: 20
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: c.gridColor }, ticks: { color: c.textColor } },
                x: { grid: { display: false }, ticks: { color: c.textColor, maxRotation: 45, font: { size: 10 } } }
            }
        }
    });

    // 2. Competitive Intelligence (Doughnut)
    const sellerLabels = data.sellers.top.slice(0, 4).map(s => s.name);
    const sellerData = data.sellers.top.slice(0, 4).map(s => s.count);
    if (data.sellers.othersCount > 0) {
        sellerLabels.push('Others');
        sellerData.push(data.sellers.othersCount);
    }

    const ctxComp = document.getElementById('competitionChart').getContext('2d');
    competitionChart = new Chart(ctxComp, {
        type: 'doughnut',
        data: {
            labels: sellerLabels,
            datasets: [{
                data: sellerData,
                backgroundColor: c.shades.slice(0, sellerLabels.length),
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '70%',
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: c.textColor,
                        usePointStyle: true,
                        pointStyle: 'circle',
                        padding: 12,
                        font: { size: 10 },
                        generateLabels: (chart) => {
                            const data = chart.data;
                            return data.labels.map((label, i) => ({
                                text: label.length > 14 ? label.substring(0, 14) + '…' : label,
                                fillStyle: data.datasets[0].backgroundColor[i],
                                strokeStyle: 'transparent',
                                pointStyle: 'circle',
                                index: i
                            }));
                        }
                    }
                }
            }
        }
    });

    // 3. Variant/Product Intelligence (Horizontal Bar)
    let variantLabels = [];
    let variantData = [];
    let variantLabelPrefix = 'Listing Count';
    
    if (data.ai && data.ai.dynamicVariants && data.ai.dynamicVariants.length > 0) {
        variantLabels = data.ai.dynamicVariants.map(v => v.name);
        variantData = data.ai.dynamicVariants.map(v => v.percentage);
        variantLabelPrefix = 'Market Share (%)';
    } else if (data.variants && data.variants.length > 0) {
        variantLabels = data.variants.map(v => v.name);
        variantData = data.variants.map(v => v.count);
    } else {
        variantLabels = Object.keys(data.conditions);
        variantData = Object.values(data.conditions);
    }

    const ctxVariant = document.getElementById('variantChart').getContext('2d');
    variantChart = new Chart(ctxVariant, {
        type: 'bar',
        data: {
            labels: variantLabels.slice(0, 6),
            datasets: [{
                label: variantLabelPrefix,
                data: variantData.slice(0, 6),
                backgroundColor: [c.accentPositive, ...c.shades.slice(1, 6)],
                borderRadius: 4,
                barThickness: 16
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: c.gridColor }, ticks: { color: c.textColor } },
                y: { grid: { display: false }, ticks: { color: c.textColor, font: { size: 11 } } }
            }
        }
    });
}

function updateChartColors() {
    if (lastAnalyticsData) {
        updateCharts(lastAnalyticsData);
    } else {
        initEmptyCharts();
    }
    // Regenerate heatmap
    const heatmapContainer = document.getElementById('seasonalityHeatmap');
    heatmapContainer.innerHTML = '';
    generateHeatmap();
}

function initEmptyCharts() {
    if (pricingChart) pricingChart.destroy();
    if (competitionChart) competitionChart.destroy();
    if (variantChart) variantChart.destroy();

    const c = getChartColors();

    const ctxPricing = document.getElementById('pricingChart').getContext('2d');
    pricingChart = new Chart(ctxPricing, {
        type: 'bar',
        data: {
            labels: ['—', '—', '—', '—', '—', '—'],
            datasets: [{ label: 'Frekuensi Listing', data: [0, 0, 0, 0, 0, 0], backgroundColor: c.bgTertiary, borderRadius: 4, barThickness: 20 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: c.gridColor }, ticks: { color: c.textColor } },
                x: { grid: { display: false }, ticks: { color: c.textColor } }
            }
        }
    });

    const ctxComp = document.getElementById('competitionChart').getContext('2d');
    competitionChart = new Chart(ctxComp, {
        type: 'doughnut',
        data: {
            labels: ['Waiting for data'],
            datasets: [{ data: [1], backgroundColor: [c.bgTertiary], borderWidth: 0 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '70%',
            plugins: { legend: { position: 'right', labels: { color: c.textColor, usePointStyle: true, pointStyle: 'circle', padding: 15, font: { size: 11 } } } }
        }
    });

    const ctxVariant = document.getElementById('variantChart').getContext('2d');
    variantChart = new Chart(ctxVariant, {
        type: 'bar',
        data: {
            labels: ['Waiting for data'],
            datasets: [{ label: 'Data', data: [0], backgroundColor: [c.bgTertiary], borderRadius: 4, barThickness: 16 }]
        },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: c.gridColor }, ticks: { color: c.textColor } },
                y: { grid: { display: false }, ticks: { color: c.textColor, font: { size: 11 } } }
            }
        }
    });
}

// ── Update Geographic Demand ────────────────────────────────────────
function updateGeography(geoData) {
    const geoList = document.getElementById('geo-list');
    const geoAlert = document.getElementById('geo-alert');

    if (!geoData || geoData.length === 0) {
        geoList.innerHTML = '<div class="geo-item"><span class="region">Tidak ada data lokasi</span><div class="progress-bar"><div class="fill" style="width:0%"></div></div><span class="percentage">—</span></div>';
        return;
    }

    geoList.innerHTML = geoData.map(loc => `
        <div class="geo-item">
            <span class="region" title="${loc.region}">${loc.region}</span>
            <div class="progress-bar"><div class="fill" style="width: ${loc.percentage}%"></div></div>
            <span class="percentage">${loc.percentage}%</span>
        </div>
    `).join('');

    // Update alert based on top location
    const topRegion = geoData[0];
    geoAlert.className = 'alert-box info';
    geoAlert.innerHTML = `<i data-lucide="info"></i><span>Largest region (Sellers): ${topRegion.region} (${topRegion.percentage}% dari total listing).</span>`;
}

function updateDemandGeography(geoData) {
    const geoList = document.getElementById('geo-demand-list');
    const geoAlert = document.getElementById('geo-demand-alert');

    if (!geoData || geoData.length === 0) {
        geoList.innerHTML = '<div class="geo-item"><span class="region">No search trend data</span><div class="progress-bar"><div class="fill" style="width:0%"></div></div><span class="percentage">—</span></div>';
        geoAlert.className = 'alert-box warning';
        geoAlert.innerHTML = `<i data-lucide="alert-triangle"></i><span>Google Trends API tidak mengembalikan data untuk query ini.</span>`;
        return;
    }

    geoList.innerHTML = geoData.map(loc => `
        <div class="geo-item">
            <span class="region" title="${loc.region}">${loc.region}</span>
            <div class="progress-bar"><div class="fill" style="width: ${loc.percentage}%"></div></div>
            <span class="percentage">${loc.percentage}%</span>
        </div>
    `).join('');

    const topRegion = geoData[0];
    geoAlert.className = 'alert-box positive';
    geoAlert.innerHTML = `<i data-lucide="search"></i><span>Highest demand comes from: ${topRegion.region}. Targetkan iklan (Ads) ke negara ini.</span>`;
}

// ── Update Keywords ─────────────────────────────────────────────────
function updateKeywords(keywords, query, aiData) {
    const container = document.getElementById('power-keywords');
    const statsEl = document.getElementById('keyword-stats');

    // Use AI keywords if available
    if (aiData && aiData.keywordsToUse && aiData.keywordsToUse.length > 0) {
        let html = aiData.keywordsToUse.map(kw =>
            `<span class="tag positive">${kw}</span>`
        ).join('');

        if (aiData.keywordsToAvoid && aiData.keywordsToAvoid.length > 0) {
            html += '<div style="width:100%; margin-top:12px;"><h4 style="font-size:0.85rem; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:10px;">Keywords to Avoid</h4></div>';
            html += aiData.keywordsToAvoid.map(kw =>
                `<span class="tag negative">${kw}</span>`
            ).join('');
        }

        container.innerHTML = html;

        // AI title suggestion
        if (aiData.titleSuggestion) {
            statsEl.innerHTML = `<strong>AI Suggested Title:</strong> "${aiData.titleSuggestion}"`;
        } else {
            const topKw = aiData.keywordsToUse.slice(0, 3).map(k => `"${k}"`).join(', ');
            statsEl.textContent = `AI recommends: ${topKw}. Gunakan di judul listing untuk visibilitas maksimal.`;
        }
        return;
    }

    // Fallback to data-driven keywords
    if (!keywords || keywords.length === 0) {
        container.innerHTML = '<span class="tag neutral">Tidak cukup data keyword</span>';
        return;
    }

    container.innerHTML = keywords.slice(0, 8).map(kw =>
        `<span class="tag positive">${kw.word} (${kw.count})</span>`
    ).join('');

    const topKw = keywords.slice(0, 3).map(k => `"${k.word}"`).join(', ');
    statsEl.textContent = `Keywords paling sering muncul: ${topKw}. Gunakan di judul listing untuk visibilitas maksimal.`;
}

// ── Update Sample Items ─────────────────────────────────────────────
function updateSampleItems(items) {
    const container = document.getElementById('sample-items');

    if (!items || items.length === 0) {
        container.innerHTML = '<p style="color: var(--text-tertiary); grid-column: 1/-1; text-align: center; padding: 24px;">Tidak ada listing ditemukan.</p>';
        return;
    }

    container.innerHTML = items.map(item => `
        <a class="sample-item" href="${item.link || '#'}" target="_blank" rel="noopener noreferrer">
            ${item.image ? `<img class="sample-item-img" src="${item.image}" alt="Product" loading="lazy" onerror="this.style.display='none'">` : '<div class="sample-item-img"></div>'}
            <div class="sample-item-info">
                <div class="sample-item-title">${escapeHtml(item.title)}</div>
                <div class="sample-item-price">${item.price}</div>
                <div class="sample-item-condition">${item.condition} · ${item.seller}</div>
            </div>
        </a>
    `).join('');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── Update Conclusion ───────────────────────────────────────────────
function updateConclusion(data, query, sym) {
    // Use AI opportunity score if available
    let oppScore;
    if (data.ai && data.ai.opportunityScore) {
        oppScore = data.ai.opportunityScore;
    } else {
        const factors = [];
        factors.push(data.sellers.unique < 15 ? 85 : data.sellers.unique < 30 ? 65 : 45);
        factors.push(data.buyingOptions.binPercentage > 70 ? 75 : 55);
        factors.push(100 - data.entryBarrier);
        factors.push(data.pricing.max > data.pricing.avg * 1.5 ? 80 : 60);
        oppScore = Math.round(factors.reduce((a, b) => a + b, 0) / factors.length);
    }

    document.getElementById('opp-score-circle').style.setProperty('--score', oppScore);
    document.getElementById('opp-score-value').textContent = oppScore;

    // Insights — prefer AI
    if (data.ai && data.ai.insights && data.ai.insights.length > 0) {
        let insightsHtml = data.ai.insights.map(i => `<li>${i}</li>`).join('');
        // Add risk assessment and seasonal tip
        if (data.ai.riskAssessment) {
            insightsHtml += `<li><strong>⚠️ Risiko:</strong> ${data.ai.riskAssessment}</li>`;
        }
        if (data.ai.seasonalTip) {
            insightsHtml += `<li><strong>📅 Seasonal:</strong> ${data.ai.seasonalTip}</li>`;
        }
        document.getElementById('conclusion-insights').innerHTML = insightsHtml;
    } else {
        const insights = [];
        insights.push(`Ditemukan ${data.totalItems} listing aktif untuk "${query}" dengan harga rata-rata ${sym}${formatNumber(data.pricing.avg)}.`);
        if (data.buyingOptions.binPercentage > 70) {
            insights.push(`Mayoritas listing (${data.buyingOptions.binPercentage}%) menggunakan Buy It Now — pasar lebih menyukai harga tetap.`);
        } else {
            insights.push(`Mix auction/BIN menunjukkan pasar yang dinamis. Pertimbangkan auction untuk item langka.`);
        }
        if (data.sellers.unique < 15) {
            insights.push(`Hanya ${data.sellers.unique} sellers unik — pasar ini belum terlalu ramai, peluang bagus.`);
        } else {
            insights.push(`${data.sellers.unique} sellers aktif menunjukkan pasar yang kompetitif. Diferensiasi adalah kunci.`);
        }
        if (data.geography.length > 0) {
            insights.push(`Region dominan: ${data.geography[0].region} (${data.geography[0].percentage}%). Sesuaikan shipping dan targeting.`);
        }
        if (data.keywords.length > 0) {
            const topKws = data.keywords.slice(0, 3).map(k => `"${k.word}"`).join(', ');
            insights.push(`Keywords utama di listing: ${topKws}. Masukkan ke judul untuk SEO eBay.`);
        }
        document.getElementById('conclusion-insights').innerHTML =
            insights.map(i => `<li>${i}</li>`).join('');
    }

    // Action Plans — prefer AI
    if (data.ai && data.ai.actionPlan && data.ai.actionPlan.length > 0) {
        document.getElementById('conclusion-actions').innerHTML =
            data.ai.actionPlan.map(a => `<li><strong>${a.day}:</strong> ${a.action}</li>`).join('');
    } else {
        const actions = [];
        actions.push(`<strong>Hari 1:</strong> Buat listing dengan harga ${sym}${formatNumber(data.pricing.optimal)} dan 12 foto HD.`);
        if (data.buyingOptions.binPercentage > 60) {
            actions.push(`<strong>Hari 1:</strong> Gunakan format Buy It Now dengan Best Offer (batas bawah ${sym}${formatNumber(data.pricing.median * 0.9)}).`);
        } else {
            actions.push(`<strong>Hari 1:</strong> Mulai dengan Auction starting dari ${sym}${formatNumber(data.pricing.min * 0.8)} untuk menarik bid war.`);
        }
        actions.push(`<strong>Hari 2:</strong> Tawarkan free shipping untuk menarik lebih banyak pembeli (konversi meningkat ~22%).`);
        if (data.keywords.length > 2) {
            actions.push(`<strong>Hari 2:</strong> Optimalkan judul dengan keywords: ${data.keywords.slice(0, 3).map(k => k.word).join(', ')}.`);
        }
        actions.push(`<strong>Hari 7:</strong> Evaluasi watchers. Jika rendah, turunkan harga 3-5% atau promote listing.`);
        document.getElementById('conclusion-actions').innerHTML =
            actions.map(a => `<li>${a}</li>`).join('');
    }
}

// ── Generate Seasonality Heatmap ────────────────────────────────────
function generateHeatmap(aiTimingData = null) {
    const heatmapContainer = document.getElementById('seasonalityHeatmap');
    heatmapContainer.innerHTML = ''; // Clear existing heatmap
    
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    
    // Use AI demand data if available, otherwise fallback to generic dummy data
    let demandData = [0.3, 0.4, 0.5, 0.6, 0.5, 0.7, 0.8, 0.7, 0.6, 0.8, 0.9, 0.95];
    
    if (aiTimingData && aiTimingData.seasonalityIndex && aiTimingData.seasonalityIndex.length === 12) {
        demandData = aiTimingData.seasonalityIndex;
    }
    
    // Update Optimal Day and Time text
    if (aiTimingData) {
        if (aiTimingData.optimalDay) document.getElementById('insight-optimal-day').textContent = aiTimingData.optimalDay;
        if (aiTimingData.optimalTime) document.getElementById('insight-optimal-time').textContent = aiTimingData.optimalTime;
    } else {
        document.getElementById('insight-optimal-day').textContent = 'Sunday';
        document.getElementById('insight-optimal-time').textContent = '19:00 - 21:00';
    }
    
    const isDark = document.body.classList.contains('dark-mode');

    months.forEach((month, index) => {
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        cell.title = `${month}: Demand Index ${demandData[index]}`;
        
        const opacity = 0.2 + (demandData[index] * 0.7);
        const bgColor = isDark ? `rgba(248, 249, 250, ${opacity})` : `rgba(18, 18, 18, ${opacity})`;
        
        cell.style.backgroundColor = bgColor;
        
        cell.innerHTML = `<span style="position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); font-size: 9px; color: ${isDark ? (opacity > 0.5 ? '#121212' : '#adb5bd') : (opacity > 0.5 ? '#ffffff' : '#5c5f66')}; font-weight: 600;">${month}</span>`;
        
        heatmapContainer.appendChild(cell);
    });
}

// ── Event Listeners ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initEmptyCharts();
    generateHeatmap();
    
    // Analyze button
    analyzeBtn.addEventListener('click', runAnalysis);

    // Enter key on search input
    document.getElementById('search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runAnalysis();
    });

    // Pill tag click interaction
    document.querySelectorAll('.pill-tag').forEach(tag => {
        tag.addEventListener('click', function() {
            document.getElementById('search-input').value = this.textContent;
            runAnalysis();
        });
    });
});

// Handle window resize for charts
window.addEventListener('resize', () => {
    if (pricingChart) pricingChart.resize();
    if (competitionChart) competitionChart.resize();
    if (variantChart) variantChart.resize();
});