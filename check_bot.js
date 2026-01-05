const { getBotStatus } = require('./recall');

async function check() {
    const id = '7799b50e-2b9e-41ea-8f15-7eb4df1b3de3'; // The ID from your logs
    console.log("Checking status for:", id);
    try {
        const status = await getBotStatus(id);
        console.log("Status:", status);
    } catch (e) {
        console.error("Error:", e.message);
    }
}
check();