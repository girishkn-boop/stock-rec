const { EMA, RSI } = require('technicalindicators');

function calculateBX(prices) {
    if (!prices || prices.length < 200) return { decision: "DATA_ERR", reason: "Wait for EOD Data" };
    const ema200 = EMA.calculate({ period: 200, values: prices }).pop();
    const ema9 = EMA.calculate({ period: 9, values: prices });
    const ema21 = EMA.calculate({ period: 21, values: prices });
    
    console.log('ema9 length:', ema9.length);
    console.log('ema21 length:', ema21.length);

    const mom = ema9.map((v, i) => v - ema21[i]).filter(x => !isNaN(x));
    console.log('mom length:', mom.length);

    const rsiMom = RSI.calculate({ period: 14, values: mom });
    console.log('rsiMom length:', rsiMom.length);

    const bxValues = EMA.calculate({ period: 5, values: rsiMom.map(v => v - 50) });
    const bx = bxValues.pop();
    const cp = prices[prices.length - 1];

    console.log('bx:', bx);
    console.log('cp:', cp);
    console.log('ema200:', ema200);

    if (cp > ema200 && bx > 2.0) return { decision: "ENTRY (LONG)", reason: "Bullish" };
    if (cp < ema200 && bx < -2.0) return { decision: "ENTRY (SHORT)", reason: "Bearish" };
    return { decision: "WATCH", reason: "Neutral" };
}

const dummyPrices = Array.from({length: 250}, (_, i) => 100 + i);
console.log(calculateBX(dummyPrices));
