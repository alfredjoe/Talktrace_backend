const recall = require('./recall');

async function testConnection() {
    console.log("Testing Recall.ai connection with default URL...");
    try {
        // Try to get status of a non-existent bot. 
        // We expect a 404 error from the API, which confirms the URL is correct and reachable.
        await recall.getBotStatus('dummy-id-12345');
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log("SUCCESS: Connected to Recall.ai API (Got expected 404 for dummy ID).");
            console.log("Default API URL is working.");
        } else {
            console.error("FAILURE: unexpected error:", error.message);
            if (error.code) console.error("Code:", error.code);
            process.exit(1);
        }
    }
}

testConnection();
