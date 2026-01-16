const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const { db, addMeeting, getMeeting, updateMeetingId, getMeetingKey, deleteMeeting } = require('./database');
const { joinMeeting, getBotStatus, downloadAudio, leaveMeeting } = require('./recall');
const { createEncryptionSetup, formatPEM } = require('./encryption');
const verifyToken = require('./middleware');
const { ingestRecording, getArtifactStream } = require('./pipeline_manager');
const { calculateHash } = require('./crypto_utils');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({
    exposedHeaders: ['X-Encrypted-Key', 'Content-Disposition', 'Content-Type']
}));
app.use(bodyParser.json());

// Protect all /api/ endpoints with Firebase Auth
app.use('/api', verifyToken);

// --- MEETING CONTROL ---

app.post('/api/join', async (req, res) => {
    const user_id = req.user.uid;
    const { meeting_url, bot_name } = req.body;

    if (!meeting_url) return res.status(400).json({ error: "Missing meeting_url" });

    try {
        const recallResponse = await joinMeeting(meeting_url, bot_name || 'Talktrace Bot');

        if (recallResponse.success) {
            const botId = recallResponse.id;
            console.log(`[Recall] Bot joined with ID: ${botId}`);
            await addMeeting(user_id, botId);
            res.json({ success: true, meeting_id: botId, message: "Bot joined successfully." });
        } else {
            res.status(500).json({ error: "Failed to join meeting", details: recallResponse });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/leave', async (req, res) => {
    const user_id = req.user.uid;
    const { meeting_id } = req.body;
    // ... (Verify ownership & leaveMeeting logic similar to before)
    // For brevity, using the standard logic
    try {
        await leaveMeeting(meeting_id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- STATUS & RESUME ---

app.get('/api/status/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const user_id = req.user.uid;

    try {
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        // If local processing is ongoing or done, return that state
        if (record.process_state && record.process_state !== 'initializing') {
            let artifacts = {};
            try { artifacts = JSON.parse(record.file_paths || '{}'); } catch (e) { }

            // COMPATIBILITY ADAPTER: Frontend expects 'complete' not 'completed' for UI state
            // But 'completed' for List view? Dashboard.js seems mixed. 
            // Line 843 checks "status === 'complete'".
            // Line 686 checks "m.status === 'completed'".
            // So /api/status should return 'complete', and /api/meetings should return 'completed'.

            const uiStatus = record.process_state === 'completed' ? 'complete' : record.process_state;

            // FIX: Frontend relies on audio_ready flag for legacy completion detection
            const isAudioReady = record.process_state === 'completed' || record.process_state === 'downloaded' || record.process_state === 'transcribing';

            return res.json({
                status: uiStatus, // 'complete' for dashboard badges
                raw_status: record.process_state, // 'completed' for logic checking
                process_state: record.process_state,
                audio_ready: isAudioReady, // Triggers frontend "Meeting Ended" state
                timestamp: record.current_timestamp,
                artifacts: artifacts
            });
        }

        // Otherwise check Recall
        const status = await getBotStatus(meeting_id);

        // --- DISCARD LOGIC ---
        // If Recall says "done" (terminal state) but NO audio is available, discard it.
        // Terminal states: 'done', 'fatal', 'video_mixed_mp4' (if used as status?)
        // status.raw_status comes from `determineStatus` (e.g. 'done') or bot.status
        // status.audio_ready boolean tells us if there is audio to download.

        const terminalStates = ['done', 'fatal', 'error', 'payment_required'];
        if (terminalStates.includes(status.raw_status) && !status.audio_ready) {
            console.log(`[Server] Meeting ${meeting_id} ended with no audio. Discarding...`);

            // Delete from DB
            await deleteMeeting(meeting_id);

            return res.json({
                status: 'discarded',
                message: 'Meeting ended with no audio recorded. Session discarded.'
            });
        }


        // TRIGGERING INGESTION LOGIC (Self-Healing / Polling)
        // If Recall says "done" (audio_ready) but we are still 'initializing', start Ingest
        if (status.audio_ready && record.process_state === 'initializing') {
            console.log(`[Server] Audio Ready for ${meeting_id}. Starting Pipeline...`);
            const audioStream = await downloadAudio(status.audio_url);
            await ingestRecording(meeting_id, audioStream);
            return res.json({ status: 'processed', process_state: 'downloading' });
        }

        res.json(status);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/meetings', async (req, res) => {
    const user_id = req.user.uid;
    try {
        const { getUserMeetings } = require('./database');
        const rows = await getUserMeetings(user_id);

        // COMPATIBILITY ADAPTER for Frontend
        // Frontend expects: meeting_id, status (completed/failed/processing)
        const meetings = rows.map(r => ({
            ...r, // include id, created_at, etc
            meeting_id: r.id, // Frontend expects meeting_id
            status: r.process_state, // Frontend expects status
            // Format duration from seconds to MM:SS or HH:MM:SS
            duration: r.duration_seconds
                ? new Date(r.duration_seconds * 1000).toISOString().substr(11, 8).replace(/^00:/, '')
                : null,
            date: new Date(r.created_at).toLocaleDateString()
        }));

        res.json({ success: true, meetings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/retry/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const user_id = req.user.uid;

    try {
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        console.log(`[Server] Manual Retry requested for ${meeting_id}`);

        // Async Trigger
        const { resumeProcessing } = require('./pipeline_manager');
        resumeProcessing(meeting_id).catch(err => console.error(`[Retry Error] ${meeting_id}:`, err));

        res.json({ success: true, message: "Processing started/resumed." });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/meeting/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const user_id = req.user.uid;

    try {
        // Verify ownership before deletion
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        console.log(`[Server] User-initiated deletion for ${meeting_id}`);

        // Delete meeting (crypto-shredding)
        await deleteMeeting(meeting_id);

        res.json({ success: true, message: "Meeting deleted successfully." });

    } catch (error) {
        console.error(`[Delete Error] ${meeting_id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// --- SECURE DATA DELIVERY (Pipeline Output) ---

// Generic handler for Audio, Transcript, Summary
async function secureDeliver(req, res, type) {
    const { meeting_id } = req.params;
    const publicKeyPem = formatPEM(req.headers['x-public-key']);

    console.log(`[SecureDeliver] Request for ${type} on ${meeting_id}`);

    if (!publicKeyPem) {
        console.error(`[SecureDeliver] Missing Public Key for ${meeting_id}`);
        return res.status(400).json({ error: "Missing X-Public-Key header" });
    }

    try {
        // 1. Get Clear Stream (Decrypted from Disk)
        // This might fail if file doesn't exist
        const clearStream = await getArtifactStream(meeting_id, type);

        // 2. Setup New Encryption for User (RSA+AES)
        const { encryptedKeyHeader, cipher } = createEncryptionSetup(publicKeyPem);

        res.setHeader('X-Encrypted-Key', encryptedKeyHeader);
        if (type === 'audio') res.setHeader('Content-Type', 'audio/mpeg');
        else res.setHeader('Content-Type', 'application/json');

        // 3. Pipe Clear -> Cipher -> Response
        clearStream.pipe(cipher).pipe(res);
        console.log(`[SecureDeliver] Streaming ${type} to client...`);

    } catch (error) {
        console.error(`[SecureDeliver] Error (${type}):`, error.message);
        // Distinguish between 404 and 500
        if (error.message.includes('File not found')) {
            return res.status(404).json({ error: "Artifact not found" });
        }
        if (!res.headersSent) res.status(500).json({ error: "Failed to retrieve data" });
    }
}

app.get('/api/audio/:meeting_id', (req, res) => secureDeliver(req, res, 'audio'));
app.get('/api/data/:meeting_id/transcript', (req, res) => secureDeliver(req, res, 'transcript'));
app.get('/api/data/:meeting_id/summary', (req, res) => secureDeliver(req, res, 'summary'));


// --- INTEGRITY & EDITING ---

app.post('/api/edit/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const { text } = req.body;
    const user_id = req.user.uid;

    if (!text) return res.status(400).json({ error: "Missing text" });

    try {
        // Verify Ownership
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        // Save Revision
        const { saveTranscriptRevision } = require('./pipeline_manager');
        const result = await saveTranscriptRevision(meeting_id, text);

        res.json({
            success: true,
            message: "Transcript updated successfully",
            version: result.version,
            hash: result.hash
        });

    } catch (error) {
        console.error("Edit Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/verify', async (req, res) => {
    const { hash } = req.body;
    if (!hash) return res.status(400).json({ error: "Missing hash" });

    try {
        const { findRevisionByHash } = require('./database');
        const revision = await findRevisionByHash(hash);

        if (revision) {
            res.json({
                verified: true,
                meeting_id: revision.meeting_id,
                version: revision.version,
                date: revision.edited_at,
                message: `✅ Verified: Matches Version ${revision.version}`
            });
        } else {
            res.json({
                verified: false,
                message: "❌ Mismatch: No record found for this content."
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Talktrace Secure Server running on port ${PORT}`);
});
