require('dotenv').config({ quiet: true });
const cron = require('node-cron');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');
const fs = require('fs-extra');
const { EMA, RSI } = require('technicalindicators');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;
const STATE_FILE = './state.json';

const BUY_THE_DIP_STOCKS = ["HIMS", "ASTS", "COIN", "HOOD", "IREN", "QPUX", "CRM", "ADBE", "IONQ", "NOW", "PANW", "AIRO", "RDDT", "ENPH", "NVO", "NKE", "MSTR", "TOST"];

const GROWTH_STOCKS = ["HIMS", "ASTS", "COIN", "HOOD", "IREN", "QPUX", "AIRO", "RDDT", "IONQ", "ENPH", "MSTR"];
const MATURE_STOCKS = ["CRM", "ADBE", "NOW", "PANW", "NVO", "NKE", "TOST"];

const ALL_TICKERS = [...BUY_THE_DIP_STOCKS];

let isRunning = false;

// --- POLYGON DATA FETCHING (5 requests per minute limit) ---
async function fetchPolygonData(ticker) {
    try {
        // Fetch last 250 days of daily bars
        const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/2023-01-01/2026-12-31?adjusted=true&sort=desc&limit=250&apiKey=${process.env.STOCK_API_KEY}`;
        const res = await axios.get(url);
        
        if (res.status === 429) return "LIMIT";
        if (!res.data.results) return null;

        // Polygon returns newest first, we need to reverse for indicators
        return res.data.results.map(day => day.c).reverse();
    } catch (e) {
        if (e.response && e.response.status === 429) return "LIMIT";
        return null;
    }
}

async function fetchFundamentals(ticker) {
    try {
        const url = `https://api.polygon.io/vX/reference/financials?ticker=${ticker}&limit=2&apiKey=${process.env.STOCK_API_KEY}`;
        const res = await axios.get(url);
        if (res.status === 429) return "LIMIT";
        return res.data.results || [];
    } catch (e) {
        if (e.response && e.response.status === 429) return "LIMIT";
        return [];
    }
}

function calculateFA(ticker, financials, currentPrice) {
    if (!financials || financials.length === 0) return { verdict: "N/A", summary: "No financial data" };
    
    const isGrowth = GROWTH_STOCKS.includes(ticker);
    const curr = financials[0]?.financials;
    const prev = financials[1]?.financials;

    if (!curr) return { verdict: "N/A", summary: "Incomplete financial data" };

    let verdict = "NEUTRAL";
    let details = [];

    // Helper to get nested values with common fallbacks
    const getVal = (obj, path) => {
        const val = path.split('.').reduce((o, i) => o?.[i], obj)?.value;
        if (val === undefined) {
            const parts = path.split('.');
            const last = parts.pop();
            const parent = parts.reduce((o, i) => o?.[i], obj);
            if (parent) {
                if (last === 'revenue' && parent['revenues']) return parent['revenues'].value;
                if (last === 'liabilities' && parent['total_liabilities']) return parent['total_liabilities'].value;
            }
            return 0;
        }
        return val;
    };

    const rev = getVal(curr, 'income_statement.revenue');
    const grossProfit = getVal(curr, 'income_statement.gross_profit');
    const grossMargin = rev ? (grossProfit / rev) * 100 : 0;
    
    const assets = getVal(curr, 'balance_sheet.current_assets');
    const liab = getVal(curr, 'balance_sheet.current_liabilities');
    const currRatio = liab ? assets / liab : 0;
    
    const eps = getVal(curr, 'income_statement.basic_earnings_per_share');
    const shares = getVal(curr, 'income_statement.basic_average_shares');
    
    const ocf = getVal(curr, 'cash_flow_statement.net_cash_flow_from_operating_activities');
    const fcf = ocf * 0.85; // Conservative estimate for CapEx

    if (isGrowth) {
        // Growth: P/S, Current Ratio, Rev Growth
        const marketCap = currentPrice * (shares || 1);
        const ps = rev ? marketCap / rev : 0;
        const prevRev = getVal(prev, 'income_statement.revenue');
        const revGrowth = prevRev ? ((rev - prevRev) / prevRev) * 100 : 0;

        details.push(`P/S: ${ps.toFixed(1)}`);
        details.push(`Growth: ${revGrowth.toFixed(1)}%`);
        details.push(`CashRatio: ${currRatio.toFixed(1)}`);

        if (ps < 12 && revGrowth > 25 && currRatio > 1.2) verdict = "BULLISH (FA)";
        else if (ps > 25 || revGrowth < 0 || currRatio < 0.8) verdict = "BEARISH (FA)";
    } else {
        // Mature: P/E, D/E, FCF Growth
        const pe = eps ? currentPrice / eps : 0;
        const debt = getVal(curr, 'balance_sheet.liabilities');
        const equity = getVal(curr, 'balance_sheet.equity') || 1;
        const deRatio = debt / equity;
        
        const prevOcf = getVal(prev, 'cash_flow_statement.net_cash_flow_from_operating_activities');
        const prevFcf = prevOcf * 0.85;
        const fcfGrowth = prevFcf ? ((fcf - prevFcf) / Math.abs(prevFcf)) * 100 : 0;

        details.push(`P/E: ${pe.toFixed(1)}`);
        details.push(`FCF Growth: ${fcfGrowth.toFixed(1)}%`);
        details.push(`D/E: ${deRatio.toFixed(1)}`);

        if (pe < 22 && fcfGrowth > 8 && deRatio < 2.5) verdict = "BULLISH (FA)";
        else if (pe > 45 || fcfGrowth < -5 || deRatio > 4.5) verdict = "BEARISH (FA)";
    }

    details.push(`Margin: ${grossMargin.toFixed(0)}%`);
    return { verdict, summary: details.join(" | ") };
}

function calculateBX(prices) {
    if (!prices || prices.length < 200) return { decision: "DATA_ERR", reason: "Wait for EOD Data" };
    
    const ema200Values = EMA.calculate({ period: 200, values: prices });
    const ema9Values = EMA.calculate({ period: 9, values: prices });
    const ema21Values = EMA.calculate({ period: 21, values: prices });
    
    if (ema200Values.length === 0 || ema9Values.length === 0 || ema21Values.length === 0) {
        return { decision: "DATA_ERR", reason: "Insufficient data for indicators" };
    }

    const ema200 = ema200Values[ema200Values.length - 1];
    
    // Align ema9 and ema21
    const len = Math.min(ema9Values.length, ema21Values.length);
    const alignedEma9 = ema9Values.slice(-len);
    const alignedEma21 = ema21Values.slice(-len);
    
    const mom = alignedEma9.map((v, i) => v - alignedEma21[i]);
    const rsiMom = RSI.calculate({ period: 14, values: mom });
    
    if (!rsiMom || rsiMom.length < 5) {
        return { decision: "DATA_ERR", reason: "Insufficient momentum for RSI" };
    }

    const bxValues = EMA.calculate({ period: 5, values: rsiMom.map(v => v - 50) });
    const bx = bxValues[bxValues.length - 1];
    const cp = prices[prices.length - 1];

    const trend = cp > ema200 ? "Above EMA200 (Bullish)" : "Below EMA200 (Bearish)";
    const momentum = bx > 2.0 ? "Strong Bullish Momentum" : (bx < -2.0 ? "Strong Bearish Momentum" : "Neutral Momentum");
    const stats = `Trend: ${trend} | Momentum: ${momentum} | Price: ${cp.toFixed(2)} | EMA200: ${ema200.toFixed(2)} | BX: ${bx.toFixed(2)}`;

    if (cp > ema200 && bx > 2.0) return { decision: "ENTRY (LONG)", reason: `Bullish Trend ${stats}` };
    if (cp < ema200 && bx < -2.0) return { decision: "ENTRY (SHORT)", reason: `Bearish Trend ${stats}` };
    return { decision: "WATCH", reason: `Neutral ${stats}` };
}

// --- REAL SOCIAL SENTIMENT FETCHING (Polygon.io News API) ---
async function fetchStocktwitsSentiment(ticker) {
    try {
        const url = `https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`;
        const res = await axios.get(url);
        if (res.data && res.data.messages) {
            const messages = res.data.messages;
            let bullish = 0;
            let bearish = 0;
            messages.forEach(m => {
                if (m.entities && m.entities.sentiment) {
                    if (m.entities.sentiment.basic === "Bullish") bullish++;
                    if (m.entities.sentiment.basic === "Bearish") bearish++;
                }
            });
            const total = bullish + bearish;
            if (total === 0) return { score: "Neutral", details: "No recent sentiment" };
            const sentiment = bullish > bearish ? "Bullish" : (bearish > bullish ? "Bearish" : "Neutral");
            return { score: sentiment, details: `${bullish}B / ${bearish}S in last ${messages.length} posts` };
        }
        return { score: "Unknown", details: "No data" };
    } catch (e) {
        console.error(`Error fetching Stocktwits for ${ticker}:`, e.message);
        return { score: "Error", details: "Fetch failed" };
    }
}

async function fetchSocialSentiment(ticker) {
    try {
        const url = `https://api.polygon.io/v2/reference/news?ticker=${ticker}&limit=1&apiKey=${process.env.STOCK_API_KEY}`;
        const res = await axios.get(url);
        
        if (res.data.results && res.data.results.length > 0) {
            const news = res.data.results[0];
            return {
                text: news.title,
                url: news.article_url,
                publisher: news.publisher.name
            };
        }
        return { text: "No recent news found", url: "#", publisher: "N/A" };
    } catch (e) {
        console.error(`Error fetching sentiment for ${ticker}:`, e.message);
        return { text: "Sentiment Error", url: "#", publisher: "N/A" };
    }
}

async function runAnalysis(forceTest = false) {
    if (isRunning) return;
    isRunning = true;
    
    const prevState = await fs.readJson(STATE_FILE).catch(() => ({}));
    let results = { list1: [] };
    let newState = { ...prevState };

    if (forceTest) {
        results.list1 = [{ ticker: "DASHBOARD", decision: "CONNECTED", reason: "Ready", sentiment: { text: "Stable", url: "#" }, fa: { verdict: "OK", summary: "Test Mode" } }];
        io.emit('full-report', results);
        isRunning = false; 
        return;
    }

    console.log(`Starting scan for ${ALL_TICKERS.length} tickers...`);

    for (const ticker of ALL_TICKERS) {
        let prices, financials;
        let retry = true;

        while (retry) {
            prices = await fetchPolygonData(ticker);
            financials = await fetchFundamentals(ticker);
            
            if (prices === "LIMIT" || financials === "LIMIT") {
                console.log(`POLYGON LIMIT for ${ticker}: WAITING 60s...`);
                io.emit('progress-update', { ticker: `LIMIT: Waiting 60s for ${ticker}...` });
                await new Promise(r => setTimeout(r, 60000));
            } else {
                retry = false;
            }
        }

        const sentiment = await fetchSocialSentiment(ticker);
        const stSentiment = await fetchStocktwitsSentiment(ticker);
        
        if (prices) {
            const analysis = calculateBX(prices);
            const cp = prices[prices.length - 1];
            const fa = calculateFA(ticker, financials, cp);
            const resObj = { ticker, ...analysis, sentiment, stSentiment, fa, timestamp: new Date().toISOString() };
            console.log(`Sending data for ${ticker}:`, resObj);
            
            // Check for flip (comparing decision string)
            const oldDecision = prevState[ticker]?.decision || prevState[ticker]; 
            if (oldDecision && oldDecision !== analysis.decision && analysis.decision !== "DATA_ERR") {
                io.emit('strategy-alert', { ticker, old: oldDecision, new: analysis.decision });
            }
            
            newState[ticker] = resObj;
            results.list1.push(resObj);
            
            // Periodically save state
            if (results.list1.length % 5 === 0) {
                await fs.writeJson(STATE_FILE, newState, { spaces: 2 });
            }

            io.emit('full-report', results);
        }
        
        io.emit('progress-update', { ticker });
        // Respecting Polygon Free Tier (5 requests/min). We make 3 requests (Price, News, Fundamentals).
        // 60s / 5 requests = 12s per request. 3 requests = 36s.
        await new Promise(r => setTimeout(r, 36500)); 
    }
    
    await fs.writeJson(STATE_FILE, newState, { spaces: 2 });
    console.log("Scan complete and state saved.");
    isRunning = false;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function sendInitialData(socket) {
    try {
        const state = await fs.readJson(STATE_FILE).catch(() => ({}));
        const results = { list1: [] };
        
        for (const ticker of ALL_TICKERS) {
            if (state[ticker]) {
                results.list1.push({ ticker, ...state[ticker] });
            }
        }
        socket.emit('full-report', results);
    } catch (e) {
        console.error("Error sending initial data:", e);
    }
}

io.on('connection', (socket) => {
    console.log('Client connected');
    sendInitialData(socket);
    
    socket.on('manual-run', () => {
        console.log('Manual run requested');
        runAnalysis(false);
    });
    
    socket.on('quick-scan', async (ticker) => {
        console.log(`Quick scan requested for ${ticker}`);
        try {
            const prices = await fetchPolygonData(ticker);
            const financials = await fetchFundamentals(ticker);
            const sentiment = await fetchSocialSentiment(ticker);
            const stSentiment = await fetchStocktwitsSentiment(ticker);

            if (!prices || prices === "LIMIT") {
                return socket.emit('quick-scan-result', { error: "Data unavailable or rate limited." });
            }

            const analysis = calculateBX(prices);
            const cp = prices[prices.length - 1];
            const fa = calculateFA(ticker, financials, cp);
            
            socket.emit('quick-scan-result', {
                ticker,
                ...analysis,
                sentiment,
                stSentiment,
                fa,
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            console.error(`Quick scan failed for ${ticker}:`, e);
            socket.emit('quick-scan-result', { error: "Internal analysis error." });
        }
    });

    socket.on('test-connection', () => {
        console.log('Test connection requested');
        runAnalysis(true);
    });
});

cron.schedule("*/30 9-16 * * 1-5", () => {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const marketOpen = hours > 9 || (hours === 9 && minutes >= 30);
    const marketClose = hours < 16;
    if (marketOpen && marketClose) {
        console.log("Scheduled scan starting...");
        runAnalysis(false);
    } else {
        console.log("Outside market hours, skipping scheduled scan.");
    }
});

if (require.main === module) {
    server.listen(PORT, () => console.log(`BX Trader Server running on http://localhost:${PORT}`));
}

module.exports = { ALL_TICKERS, runAnalysis, calculateBX, fetchPolygonData };
