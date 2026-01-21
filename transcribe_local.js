const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Runs Local Whisper on an audio file.
 * @param {string} audioFilePath - Path to the decrypted audio file (temp).
 * @returns {Promise<object>} JSON Transcript object.
 */
function runWhisper(audioFilePath) {
    return new Promise((resolve, reject) => {
        console.log(`[Whisper] Starting transcription for ${audioFilePath}...`);

        // Use our Python script for Diarization support
        const pythonScript = path.join(__dirname, 'diarize.py');
        console.log(`[Whisper] Spawning python script: ${pythonScript}`);

        const whisper = spawn('python', [
            pythonScript,
            audioFilePath
        ]);

        let outputData = '';
        let errorData = '';

        whisper.stdout.on('data', (data) => {
            outputData += data.toString();
        });

        whisper.stderr.on('data', (data) => {
            errorData += data.toString();
            console.log(`[Python Log] ${data}`); // Enabled for debugging
        });

        whisper.on('close', (code) => {
            // Attempt to parse JSON first, regardless of exit code
            // (WhisperX/Python might exit with 1 due to cleanup issues even on success)
            let success = false;
            let json = null;

            try {
                // Robust JSON Extraction
                const jsonStart = outputData.indexOf('{');
                const jsonEnd = outputData.lastIndexOf('}');

                if (jsonStart !== -1 && jsonEnd !== -1) {
                    json = JSON.parse(outputData.substring(jsonStart, jsonEnd + 1));
                    success = true;
                }
            } catch (e) {
                // Ignore parse errors here, check exit code below
            }

            if (success) {
                // If we got valid JSON, we consider it a success even if code != 0
                // (But verify strict error field inside json handled downstream)
                if (code !== 0) {
                    console.warn(`[Whisper] Python process exited with code ${code} but produced valid JSON.`);
                }
            } else if (code !== 0) {
                // Real failure (no JSON + non-zero exit)
                console.warn(`[Whisper] Python process exited with code ${code}.`);
                console.error(`[Whisper Error] ${errorData}`);

                // FALLBACK FOR DEVELOPMENT
                if (code === 1 && errorData.includes('Module \'openai-whisper\' not found')) {
                    console.log("[Whisper] Missing dependencies. Using Mock.");
                    return resolve(getMockTranscript());
                }
                return reject(new Error(`Diarization failed: ${errorData}`));
            }

            // Proceed to standard handling (success block below)
            if (!success) {
                // Code 0 but no JSON found in outputData
                // We let the catch block below handle the parse failure or throw specific error
            }

            try {
                // Robust JSON Extraction (ignores verbose logs/warnings)
                const jsonStart = outputData.indexOf('{');
                const jsonEnd = outputData.lastIndexOf('}');

                if (jsonStart === -1 || jsonEnd === -1) {
                    // If purely error log specific check (fallback handled by catch)
                    throw new Error("No JSON object found in output");
                }

                const json = JSON.parse(outputData.substring(jsonStart, jsonEnd + 1));

                if (json.error) {
                    return reject(new Error(json.error));
                }

                resolve(translateToInternalFormat(json));
            } catch (e) {
                console.error("JSON Parse Error:", e);
                console.error("Raw Output was:", outputData);
                reject(new Error("Failed to parse diarization output"));
            }
        });

        whisper.on('error', (err) => {
            console.log("[Whisper] Failed to spawn python.", err);
            reject(err);
        });
    });
}

function translateToInternalFormat(json) {
    // diarize.py returns { text: "...", segments: [{start, end, text, speaker}] }
    // We just need to ensure fields map correctly
    return {
        text: json.text,
        segments: json.segments.map(s => ({
            start: s.start,
            end: s.end,
            text: s.text.trim(),
            speaker: s.speaker || "Speaker"
        }))
    };
}

function getMockTranscript() {
    return {
        text: "This is a simulated transcript (Mock). Real diarization requires 'openai-whisper' and 'pyannote.audio'.",
        segments: [
            { start: 0, end: 5, text: "Welcome to the simulation.", speaker: "Speaker 1" },
            { start: 5, end: 10, text: "We are testing the UI labels.", speaker: "Speaker 2" }
        ]
    };
}

module.exports = { runWhisper };
