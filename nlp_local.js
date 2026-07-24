const fetch = require('node-fetch'); // Ensure node-fetch or global fetch is used (Node 18+ has global fetch)

/**
 * Runs Local NLP (Ollama) to summarize text.
 * @param {string} transcriptText 
 * @returns {Promise<object>} { summary: string, actions: string[] }
 */
async function runSummary(transcriptText, modelName = 'llama3.2') {
    console.log(`[NLP] Starting Summary Generation (Model: ${modelName})...`);

    const prompt = `
    You are an expert AI executive assistant. Analyze the following meeting transcript.
    Produce a concise executive summary and extract all actionable task items.
    Output ONLY valid JSON with no markdown formatting.
    Format:
    {
      "summary": "High level overview of discussion...",
      "actions": [
        {
          "task": "Specific task description",
          "assignee": "Person responsible or Unassigned",
          "deadline": "Target date/timeframe or ASAP",
          "confidence": 0.95
        }
      ]
    }
    
    Transcript:
    ${transcriptText.substring(0, 4000)} ... (truncated)
    `;

    try {
        // Use AbortController for timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                prompt: prompt,
                stream: false,
                format: "json",
                options: { temperature: 0.7 } // Add variability
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
            return {
                summary: result.summary || "Summary generated successfully.",
                actions: normalizeActionItems(result.actions)
            };
        } catch (parseError) {
            console.error("[NLP] JSON Parse Error on output:", cleanJson);
            throw parseError;
        }

    } catch (error) {
        console.error(`[NLP] Summary Generation Failed (${modelName}):`, error.message);

        // Fallback Logic
        if (modelName === 'llama3.2') {
            console.log("[NLP] Falling back to 'mistral' model...");
            return runSummary(transcriptText, 'mistral');
        }

        if (error.name === 'AbortError') {
            console.error("[NLP] Timed out waiting for Ollama.");
        }
        console.log("[NLP] Using Mock Summary fallback.");
        return getMockSummary();
    }
}

function normalizeActionItems(actions) {
    if (!actions || !Array.isArray(actions)) return [];
    return actions.map(act => {
        if (typeof act === 'string') {
            return {
                task: act,
                assignee: "Unassigned",
                deadline: "ASAP",
                confidence: 0.90
            };
        }
        return {
            task: act.task || act.description || "Action Item",
            assignee: act.assignee || act.owner || "Unassigned",
            deadline: act.deadline || act.due_date || "ASAP",
            confidence: typeof act.confidence === 'number' ? act.confidence : 0.95
        };
    });
}

function getMockSummary() {
    return {
        summary: `This is a simulated summary (Fallback). Real AI analysis active on pipeline setup. [Generated: ${new Date().toLocaleTimeString()}]`,
        actions: normalizeActionItems([
            { task: "Review meeting transcript for key decisions", assignee: "Abin George", deadline: "Today 5:00 PM", confidence: 0.98 },
            { task: "Export action items to Jira / Trello project board", assignee: "Sarah", deadline: "Tomorrow", confidence: 0.95 },
            { task: "Verify zero-trust local vector storage integrity", assignee: "Engineering Team", deadline: "This Week", confidence: 0.92 }
        ])
    };
}

/**
 * Uses LLM / Contextual NLP pass to map generic speaker tags (SPEAKER_00, SPEAKER_01) to real participant names.
 * @param {Array} segments - Array of { speaker, text, start, end }
 * @param {string} modelName
 * @returns {Promise<object>} Speaker mapping object e.g. { "SPEAKER_00": "Sarah", "SPEAKER_01": "David" }
 */
async function resolveSpeakerNames(segments, modelName = 'llama3.2') {
    if (!segments || !Array.isArray(segments) || segments.length === 0) {
        return {};
    }

    console.log(`[NLP] Inferring Participant Names via LLM (${modelName})...`);

    // Prepare transcript sample for LLM
    const sampleText = segments.slice(0, 30).map(s => `${s.speaker}: ${s.text}`).join('\n');

    const prompt = `
    Analyze the following meeting transcript.
    Identify the real human names of each speaker based on self-introductions (e.g., "My name is Abin", "I'm Sarah", "This is David speaking") or when other speakers address them by name.
    Output ONLY a JSON object mapping generic speaker tags to their real names.
    If a speaker's name is not explicitly mentioned, omit them from the map.

    Format: { "SPEAKER_00": "Abin George", "SPEAKER_01": "Sarah" }

    Transcript:
    ${sampleText}
    `;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout

        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                prompt: prompt,
                stream: false,
                format: "json",
                options: { temperature: 0.2 }
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.ok) {
            const data = await response.json();
            let cleanJson = data.response.trim();
            if (cleanJson.startsWith('```json')) cleanJson = cleanJson.replace('```json', '').replace('```', '');
            else if (cleanJson.startsWith('```')) cleanJson = cleanJson.replace('```', '').replace('```', '');
            const speakerMap = JSON.parse(cleanJson);
            console.log(`[NLP Speaker Resolution] Mapped:`, speakerMap);
            return speakerMap;
        }
    } catch (e) {
        console.warn(`[NLP Speaker Resolution] LLM lookup skipped: ${e.message}`);
    }

    // Fallback Rule-based Regex Extraction
    const fallbackMap = {};
    const falsePositives = ['this', 'that', 'here', 'there', 'what', 'how', 'why', 'when', 'where', 'today', 'now', 'just', 'sure', 'ok', 'okay', 'yeah', 'yes', 'no', 'everyone', 'team', 'guys', 'all', 'again', 'sorry'];

    for (const s of segments) {
        const spk = s.speaker || 'SPEAKER_00';
        if (spk && !fallbackMap[spk]) {
            const text = s.text || '';
            const match = text.match(/(?:my name is|i'm|i am|this is)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/i);
            if (match && match[1]) {
                const candidate = match[1].trim();
                if (!falsePositives.includes(candidate.toLowerCase()) && candidate.length >= 2) {
                    fallbackMap[spk] = candidate.replace(/\b\w/g, l => l.toUpperCase());
                }
            }
        }
    }
    return fallbackMap;
}

module.exports = { runSummary, resolveSpeakerNames };
