const fetch = require('node-fetch'); // Ensure node-fetch or global fetch is used (Node 18+ has global fetch)

/**
 * Runs Local NLP (Ollama) to summarize text.
 * @param {string} transcriptText 
 * @returns {Promise<object>} { summary: string, actions: string[] }
 */
async function runSummary(transcriptText) {
    console.log("[NLP] Starting Summary Generation (Ollama API)...");

    const prompt = `
    You are a meeting assistant. Analyze the following transcript.
    Output ONLY valid JSON with no markdown formatting.
    Format: { "summary": "...", "actions": ["...", "..."] }
    
    Transcript:
    ${transcriptText.substring(0, 4000)} ... (truncated)
    `;

    const model = 'mistral'; // Ensure this model is pulled: 'ollama pull mistral'

    try {
        // Use AbortController for timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                prompt: prompt,
                stream: false, // Important: Disable streaming for simple JSON response
                format: "json" // Force JSON mode if supported by model/ollama version
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`Ollama API Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        // Parse the 'response' field from Ollama
        let cleanJson = data.response.trim();

        // Cleanup if markdown code blocks persist
        if (cleanJson.startsWith('```json')) cleanJson = cleanJson.replace('```json', '').replace('```', '');
        else if (cleanJson.startsWith('```')) cleanJson = cleanJson.replace('```', '').replace('```', '');

        try {
            const result = JSON.parse(cleanJson);
            return result;
        } catch (parseError) {
            console.error("[NLP] JSON Parse Error on output:", cleanJson);
            throw parseError;
        }

    } catch (error) {
        console.error("[NLP] Summary Generation Failed:", error.message);
        if (error.name === 'AbortError') {
            console.error("[NLP] Timed out waiting for Ollama.");
        }
        console.log("[NLP] Using Mock Summary fallback.");
        return getMockSummary();
    }
}

function getMockSummary() {
    return {
        summary: "This is a simulated summary. Install 'ollama' and pull a model (mistral) to generate real summaries.",
        actions: [
            "Install Ollama",
            "Run 'ollama pull mistral'",
            "Restart Server"
        ]
    };
}

module.exports = { runSummary };
