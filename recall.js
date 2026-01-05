const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.RECALL_API_KEY;
// Allow region to be configured via env, default to us-west-2
const API_URL = process.env.RECALL_API_URL || 'https://us-west-2.recall.ai/api/v1/bot';

const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Token ${API_KEY}`
};

/**
 * Join a meeting using Recall.ai
 * @param {string} meetingUrl 
 * @param {string} botName 
 */
async function joinMeeting(meetingUrl, botName = "Talktrace Bot") {
    try {
        console.log(`[Recall] Joining meeting: ${meetingUrl}`);

        const payload = {
            meeting_url: meetingUrl,
            bot_name: botName,
            chat: {
                auto_send_message: "Hi! I'm here to take notes. Please allow me to record this meeting locally when the pop-up appears."
            },
            automatic_leave: {
                recording_permission_denied_timeout: 120
            },
            recording_config: {
                transcript: {
                    provider: {
                        recallai_streaming: {
                            mode: "prioritize_low_latency",
                            language_code: "en"
                        }
                    }
                },
                audio_mixed_mp3: {},
                audio_mixed_raw: {},
                video_mixed_mp4: null
            },
            automatic_audio_output: {
                in_call_recording: {
                    data: {
                        kind: 'mp3',
                        b64_data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV'
                    }
                }
            }
        };

        const response = await axios.post(API_URL, payload, { headers });
        console.log("[Recall] Bot Response:", JSON.stringify(response.data, null, 2));

        return {
            success: true,
            id: response.data.id,
            data: response.data
        };

    } catch (error) {
        console.error("Recall API Error (Join):", error.response?.data || error.message);
        throw new Error(JSON.stringify(error.response?.data || error.message));
    }
}

/**
 * Get the status of a bot
 * @param {string} botId 
 */


/**
 * Helper to determine bot status from the complex object
 * @param {object} bot 
 */
function determineStatus(bot) {
    if (bot.status) return bot.status;
    if (bot.status_changes && bot.status_changes.length > 0) {
        const lastStatus = bot.status_changes[bot.status_changes.length - 1].code;
        console.log(`[Recall Status DBG] Derived status: ${lastStatus}`);
        return lastStatus;
    }
    return 'unknown';
}

/**
 * Get the status of a bot
 * @param {string} botId 
 */
async function getBotStatus(botId) {
    try {
        const response = await axios.get(`${API_URL}/${botId}`, { headers });
        const bot = response.data;
        // Use helper to get raw status
        const rawStatus = determineStatus(bot);

        // Extract recording URL from the new structure (media_shortcuts)
        let audioUrl = null;
        if (bot.recordings && bot.recordings.length > 0) {
            // Sort by created_at or just take the last one? 
            // Usually we want the main meeting recording.
            const latestRecording = bot.recordings[bot.recordings.length - 1];
            // Priority: Audio (MP3) > Video (MP4) to save bandwidth for Whisper
            const shortcuts = latestRecording.media_shortcuts;
            if (shortcuts) {
                console.log("[Recall Debug] ALL Shortcuts:", Object.keys(shortcuts));

                if (shortcuts.audio_mixed_raw) {
                    audioUrl = shortcuts.audio_mixed_raw.data.download_url;
                    console.log("[Recall] SUCCESS: Selected 'audio_mixed_raw' (Lossless HQ)");
                } else if (shortcuts.audio_mixed_mp3) {
                    audioUrl = shortcuts.audio_mixed_mp3.data.download_url;
                    console.log("[Recall] SUCCESS: Selected 'audio_mixed_mp3' (Standard MP3)");
                } else if (shortcuts.audio) {
                    audioUrl = shortcuts.audio.data.download_url;
                    console.log("[Recall] Selected 'audio' (MP3)");
                } else if (shortcuts.audio_hq) {
                    audioUrl = shortcuts.audio_hq.data.download_url;
                    console.log("[Recall] Selected 'audio_hq' (MP3)");
                } else if (shortcuts.audio_mixed) {
                    audioUrl = shortcuts.audio_mixed.data.download_url;
                    console.log("[Recall] FAIL: Fell back to 'audio_mixed' (MP4 Container)");
                } else if (shortcuts.video_mixed) {
                    audioUrl = shortcuts.video_mixed.data.download_url;
                    console.log("[Recall] FAIL: Fell back to 'video_mixed' (MP4)");
                }
            }
        }

        // Fallback for older API structure if needed, or remove if deprecated
        if (!audioUrl && bot.video_url) {
            audioUrl = bot.video_url;
        }

        const ready = !!audioUrl;

        return {
            status: ready ? 'processed' : 'processing',
            audio_ready: ready,
            audio_url: audioUrl,
            raw_status: rawStatus
        };

    } catch (error) {
        console.error("Recall API Error (Status):", error.response?.data || error.message);
        throw error;
    }
}

/**
 * Download audio from the given URL
 * @param {string} url 
 */
async function downloadAudio(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'stream'
        });
        return response.data;
    } catch (error) {
        console.error("Audio Download Error:", error.message);
        throw error;
    }
}

/**
 * Leave a meeting
 * @param {string} botId 
 */
async function leaveMeeting(botId) {
    try {
        await axios.post(`${API_URL}/${botId}/leave_call/`, {}, { headers });
        return { success: true };
    } catch (error) {
        console.error("Recall API Error (Leave):", error.response?.data || error.message);
        throw error;
    }
}

/**
 * Play a custom audio file (MP3 Base64) through the bot.
 * @param {string} botId
 * @param {string} base64Audio MP3 file encoded as Base64
 */
async function playAudio(botId, base64Audio) {
    try {
        console.log(`[Recall] Playing audio for bot: ${botId}`);
        const payload = {
            kind: 'mp3',
            b64_data: base64Audio
        };
        await axios.post(`${API_URL}/${botId}/output_audio/`, payload, { headers });
        console.log("[Recall] Audio output queued successfully.");
        return { success: true };
    } catch (error) {
        console.error("Recall API Error (Play Audio):", error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    joinMeeting,
    getBotStatus,
    downloadAudio,
    leaveMeeting,
    playAudio
};
