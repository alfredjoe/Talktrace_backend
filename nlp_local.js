const { spawn } = require('child_process');

/**
 * Runs Local NLP (Ollama) to summarize text.
 * @param {string} transcriptText 
 * @returns {Promise<object>} { summary: string, actions: string[] }
 */
function runSummary(transcriptText) {
    return new Promise((resolve, reject) => {
        console.log("[NLP] Starting Summary Generation (Ollama)...");

        const prompt = `
        You are a meeting assistant. Analyze the following transcript.
        Output ONLY valid JSON with no markdown formatting.
        Format: { "summary": "...", "actions": ["...", "..."] }
        
        Transcript:
        ${transcriptText.substring(0, 4000)} ... (truncated)
        `;

        // Using "mistral" or "llama3" - adjust depending on what user has pulled
        const model = 'mistral';

        const ollama = spawn('ollama', ['run', model, prompt]);

        let outputData = '';
        let errorData = '';

        ollama.stdout.on('data', (data) => outputData += data.toString());
        ollama.stderr.on('data', (data) => errorData += data.toString());

        ollama.on('close', (code) => {
            if (code !== 0) {
                console.warn("[NLP] Ollama failed/not found. Using Mock.");
                return resolve(getMockSummary());
            }

            try {
                // Clean output (sometimes models add markdown backticks)
                let cleanJson = outputData.trim();
                if (cleanJson.startsWith('```json')) cleanJson = cleanJson.replace('```json', '').replace('```', '');

                const result = JSON.parse(cleanJson);
                resolve(result);
            } catch (e) {
                console.error("[NLP] JSON Parse Error:", e);
                resolve(getMockSummary());
            }
        });

        ollama.on('error', () => {
            console.log("[NLP] Mocking Summary (Ollama not found).");
            resolve(getMockSummary());
        });
    });
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
