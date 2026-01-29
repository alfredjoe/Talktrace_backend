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

            // FIX: Immediately set state to 'downloading' to prevent race conditions from concurrent polls
            // This blocks other requests from entering this block
            const { updateProcessState } = require('./database');
            await updateProcessState(meeting_id, 'downloading');

            // Async Background Process
            (async () => {
                try {
                    const audioStream = await downloadAudio(status.audio_url);
                    await ingestRecording(meeting_id, audioStream);
                } catch (err) {
                    console.error(`[Ingest Error] ${meeting_id}:`, err);
                    await updateProcessState(meeting_id, 'failed');
                }
            })();

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

// COMBINED ENDPOINT (Frontend Adapter)
// Frontend calls /api/data/:meeting_id hoping for { transcript, summary }
app.get('/api/data/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const publicKeyPem = formatPEM(req.headers['x-public-key']);

    if (!publicKeyPem) return res.status(400).json({ error: "Missing X-Public-Key header" });

    try {
        const { getCombinedData } = require('./pipeline_manager');

        // 1. Get Combined Data (Decrypted Object)
        const combinedData = await getCombinedData(meeting_id);

        // 2. Convert to Buffer for Encryption
        const dataBuffer = Buffer.from(JSON.stringify(combinedData));

        // 3. Encrypt for Client (RSA+AES)
        const { encryptedKeyHeader, cipher } = createEncryptionSetup(publicKeyPem);

        res.setHeader('X-Encrypted-Key', encryptedKeyHeader);
        res.setHeader('Content-Type', 'application/json');

        // 4. Stream Encrypted Response
        // Since we have a buffer, we can create a readable stream or just write to cipher
        cipher.pipe(res);
        cipher.write(dataBuffer);
        cipher.end();

        console.log(`[SecureDeliver] Streamed Combined Data for ${meeting_id}`);

    } catch (error) {
        console.error(`[SecureDeliver] Combined Error:`, error.message);
        if (error.message.includes("Key not found")) return res.status(404).json({ error: "Meeting data not found" });
        res.status(500).json({ error: "Failed to retrieve data" });
    }
});


// --- INTEGRITY & EDITING ---

app.post('/api/edit/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const { text, segments } = req.body;
    const user_id = req.user.uid;

    if (!text) return res.status(400).json({ error: "Missing text" });

    try {
        // Verify Ownership
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        // Save Revision
        const { saveTranscriptRevision } = require('./pipeline_manager');
        const result = await saveTranscriptRevision(meeting_id, text, segments); // Pass segments

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
    // Accepts 'hash' (string), 'hashes' (array), or 'content' (string)
    const { hash, hashes, content, meeting_id } = req.body;

    if (!hash && !hashes && !content) return res.status(400).json({ error: "Missing verification data" });

    try {
        let candidates = [];

        if (hashes && Array.isArray(hashes)) candidates = [...hashes];
        if (hash) candidates.push(hash);
        if (content) {
            const { calculateHash } = require('./crypto_utils');
            candidates.push(calculateHash(content));
        }

        // Deduplicate
        candidates = [...new Set(candidates)];

        const { findRevisionByHash, getRevisions } = require('./database');

        let match = null;
        let matchedHash = null;

        // 1. FAST PATH: Exact Hash Lookup (O(1))
        for (const h of candidates) {
            const revision = await findRevisionByHash(h);
            if (revision) {
                match = revision;
                matchedHash = h;
                break;
            }
        }

        // 2. SLOW PATH: Fuzzy Verification (If Exact Match Failed AND meeting_id provided)
        // This handles PDF wrapping inconsistencies by comparing "collapsed" content server-side.
        if (!match && meeting_id) {
            console.log(`[Verify] Exact match failed. Attempting Fuzzy Check for ${meeting_id}...`);
            const { getRevisionContent } = require('./pipeline_manager');
            const { calculateHash } = require('./crypto_utils');

            // Fetch all revisions (Transcript & Summary)
            const allRevisions = [
                ...(await getRevisions(meeting_id, 'transcript')),
                ...(await getRevisions(meeting_id, 'summary'))
            ];

            for (const rev of allRevisions) {
                // Decrypt content (Expensive!)
                const json = await getRevisionContent(meeting_id, rev.id);
                if (!json) continue;

                let textToCheck = "";
                if (rev.type === 'transcript') textToCheck = json.text || "";
                else if (rev.type === 'summary') textToCheck = json.summary || "";

                if (!textToCheck) continue;

                // Generate Server-Side Variants
                // 1. Collapsed (Split by whitespace, join by single space) - Matches PDF extraction
                const collapsed = textToCheck.replace(/\s+/g, ' ').trim();
                const collapsedHash = calculateHash(collapsed);

                // Variant A: Just Summary matches
                if (candidates.includes(collapsedHash)) {
                    match = rev;
                    matchedHash = collapsedHash;
                    console.log(`[Verify] Fuzzy Match Found (Summary)! Version ${rev.version}`);
                    break;
                }

                // Variant B: PDF Simulation (Summary + Actions with Headers)
                if (rev.type === 'summary') {
                    // Reconstruct EXACT PDF layout:
                    // SUMMARY: ...
                    // ACTION ITEMS:
                    // - Action 1
                    let pdfText = "";
                    if (json.summary) pdfText += `SUMMARY: ${json.summary} `; // Join with space for collapse
                    if (json.actions && Array.isArray(json.actions)) {
                        pdfText += `ACTION ITEMS: `;
                        // Actions are usually "- Action text"
                        const actionBullets = json.actions.map(a => {
                            if (typeof a === 'string') return `- ${a}`;
                            return `- ${a.action}${a.with ? ` (with ${a.with})` : ''}${a.details ? `: ${a.details}` : ''}`;
                        }).join(' ');
                        pdfText += actionBullets;
                    }

                    const pdfHash = calculateHash(pdfText.replace(/\s+/g, ' ').trim());

                    if (candidates.includes(pdfHash)) {
                        match = rev;
                        matchedHash = pdfHash;
                        console.log(`[Verify] Fuzzy Match Found (PDF Simulation)! Version ${rev.version}`);
                        break;
                    }
                }
            }
        }

        if (match) {
            res.json({
                verified: true,
                meeting_id: match.meeting_id,
                version: match.version,
                type: match.type,
                date: match.edited_at,
                calculated_hash: matchedHash,
                message: `✅ Verified: Matches ${match.type} Version ${match.version}`
            });
        } else {
            res.json({
                verified: false,
                candidates_checked: candidates.length,
                message: "❌ Mismatch: No record found for this content."
            });
        }
    } catch (error) {
        console.error("Verify Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/history/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const user_id = req.user.uid;
    const type = req.query.type || 'transcript'; // default to transcript

    try {
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        const { getRevisions } = require('./database');
        const revisions = await getRevisions(meeting_id, type);

        res.json({ success: true, revisions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/revision/:revision_id/content', async (req, res) => {
    const { revision_id } = req.params;
    const user_id = req.user.uid;

    try {
        const { getRevision, getMeeting } = require('./database');
        const revision = await getRevision(revision_id);

        if (!revision) return res.status(404).json({ error: "Revision not found" });

        const record = await getMeeting(revision.meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        const { getRevisionContent } = require('./pipeline_manager');
        const content = await getRevisionContent(revision.meeting_id, revision_id);

        if (!content) return res.status(404).json({ error: "Content not found" });

        res.json({ success: true, content });
    } catch (error) {
        console.error("Revision Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/regenerate_summary/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const user_id = req.user.uid;

    try {
        const { getMeeting } = require('./database');
        const record = await getMeeting(meeting_id);

        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        const { regenerateSummary } = require('./pipeline_manager');
        await regenerateSummary(meeting_id);

        res.json({ success: true, message: "Summary regeneration started." });
    } catch (error) {
        console.error("Regenerate Error:", error);
        res.status(500).json({ error: error.message });
    }
});



app.get('/api/meeting/:meeting_id/version/:version', async (req, res) => {
    const { meeting_id, version } = req.params;
    const user_id = req.user.uid;

    try {
        const { getMeeting } = require('./database');
        const record = await getMeeting(meeting_id);

        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        const { getVersionSnapshot } = require('./pipeline_manager');
        const snapshot = await getVersionSnapshot(meeting_id, version);

        if (!snapshot) return res.status(404).json({ error: "Version not found" });

        res.json({ success: true, snapshot });
    } catch (error) {
        console.error("Snapshot Fetch Error:", error);
        res.status(500).json({ error: error.message });
    }
});



app.post('/api/meeting/:meeting_id/checkout', async (req, res) => {
    const { meeting_id } = req.params;
    const { version } = req.body;

    // We expect version to be a number (the target version index)
    if (version === undefined || version === null) return res.status(400).json({ error: "Version required" });

    try {
        const { getMeeting, checkoutToVersion } = require('./database');
        const record = await getMeeting(meeting_id);

        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== req.user.uid) return res.status(403).json({ error: "Unauthorized" });

        await checkoutToVersion(meeting_id, version);

        res.json({ success: true, message: `Switched to version ${version}` });
    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/revert/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const { revision_id } = req.body;
    const user_id = req.user.uid;

    if (!revision_id) return res.status(400).json({ error: "Missing revision_id" });

    try {
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        const { revertToRevision } = require('./pipeline_manager');
        const result = await revertToRevision(meeting_id, revision_id);

        res.json({
            success: true,
            message: "Reverted successfully. New version created.",
            new_version: result.version
        });

    } catch (error) {
        console.error("Revert Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- AUTO-START LOCAL AI ---
const { exec, spawn } = require('child_process');

function ensureOllamaRunning() {
    exec('tasklist /FI "IMAGENAME eq ollama.exe"', (err, stdout) => {
        if (err || !stdout.includes('ollama.exe')) {
            console.log("[Server] Ollama is not running. Starting local AI service...");
            const ollama = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
            ollama.unref();
        } else {
            console.log("[Server] Ollama is already active.");
        }
    });
}

// Start Ollama check
ensureOllamaRunning();

app.listen(PORT, () => {
    console.log(`Talktrace Secure Server running on port ${PORT}`);
});
