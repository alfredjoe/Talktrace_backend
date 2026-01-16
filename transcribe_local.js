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

        // Output format json
        // Model base (Good balance for 4GB RAM)
        const whisper = spawn('whisper', [
            audioFilePath,
            '--model', 'base',
            '--output_format', 'json',
            '--output_dir', os.tmpdir(),
            '--verbose', 'False'
        ]);

        let outputData = '';
        let errorData = '';

        whisper.stdout.on('data', (data) => {
            outputData += data.toString();
        });

        whisper.stderr.on('data', (data) => {
            errorData += data.toString();
            // console.log(`[Whisper Log] ${data}`); // Uncomment for debug
        });

        whisper.on('close', (code) => {
            if (code !== 0) {
                console.warn(`[Whisper] Process exited with code ${code}. Checking for fallback...`);
                console.error(`[Whisper Error] ${errorData}`);

                // FALLBACK FOR DEVELOPMENT (If whisper is not installed)
                if (errorData.includes('spawn whisper ENOENT') || code === 1) {
                    console.log("[Whisper] Mocking transcription (Whisper not installed/failed).");
                    return resolve(getMockTranscript());
                }
                return reject(new Error(`Whisper failed with code ${code}`));
            }

            // Whisper writes to a file in output_dir. We need to read it.
            // Filename is usually <audio_filename>.json
            const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
            const resultFile = path.join(os.tmpdir(), `${baseName}.json`);

            if (fs.existsSync(resultFile)) {
                try {
                    const json = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
                    fs.unlinkSync(resultFile); // Cleanup result
                    resolve(transformWhisperOutput(json));
                } catch (e) {
                    reject(e);
                }
            } else {
                reject(new Error("Whisper output file not found"));
            }
        });

        whisper.on('error', (err) => {
            console.log("[Whisper] Mocking transcription (Whisper binary not found).");
            resolve(getMockTranscript());
        });
    });
}

function transformWhisperOutput(raw) {
    // Transform to our standard format if needed
    // Whisper JSON usually has { text, segments: [...] }
    return {
        text: raw.text,
        segments: raw.segments.map(s => ({
            start: s.start,
            end: s.end,
            text: s.text.trim(),
            speaker: "Speaker" // Whisper base doesn't do diarization well without pyannote, placeholder.
        }))
    };
}

function getMockTranscript() {
    return {
        text: "This is a simulated transcript because Local Whisper is not installed on this server. Please install 'openai-whisper' via pip to enable real transcription.",
        segments: [
            { start: 0, end: 5, text: "This is a simulated transcript.", speaker: "System" },
            { start: 5, end: 10, text: "Local Whisper is not installed.", speaker: "System" }
        ]
    };
}

module.exports = { runWhisper };
