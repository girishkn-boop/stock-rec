const { runAnalysis } = require('./index.js');
console.log("Starting test scan...");
runAnalysis(false).then(() => {
    console.log("Test scan completed.");
    process.exit(0);
}).catch(err => {
    console.error("Test scan failed:", err);
    process.exit(1);
});
