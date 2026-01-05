const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const { db, addMeeting, getMeeting, updateMeetingId } = require('./database');
const { joinMeeting, getBotStatus, downloadAudio, leaveMeeting } = require('./recall');
const { createEncryptionSetup, formatPEM } = require('./encryption');
const verifyToken = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({
    exposedHeaders: ['X-Encrypted-Key']
}));
app.use(bodyParser.json());

// Protect all /api/ endpoints with Firebase Auth
app.use('/api', verifyToken);

app.post('/api/leave', async (req, res) => {
    const user_id = req.user.uid;
    const { meeting_id } = req.body;

    if (!meeting_id) {
        return res.status(400).json({ error: "Missing meeting_id" });
    }

    try {
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        await leaveMeeting(meeting_id);
        res.json({ success: true, message: "Bot asked to leave." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 1. Join Meeting
app.post('/api/join', async (req, res) => {
    const user_id = req.user.uid;
    const { meeting_url, bot_name } = req.body;

    if (!meeting_url) {
        return res.status(400).json({ error: "Missing meeting_url" });
    }

    try {
        const recallResponse = await joinMeeting(meeting_url, bot_name || 'Talktrace Bot');

        if (recallResponse.success) {
            const botId = recallResponse.id;
            console.log(`[Recall] Bot joined with ID: ${botId}`);

            await addMeeting(user_id, botId);

            res.json({
                success: true,
                meeting_id: botId,
                resolved_id: true,
                message: "Bot joined successfully."
            });
        } else {
            console.error("Recall join failed:", recallResponse);
            res.status(500).json({ error: "Failed to join meeting", details: recallResponse });
        }

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Check Status (Self-Healing)
// 2. Check Status
app.get('/api/status/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const user_id = req.user.uid;

    try {
        // Verify ownership
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        // Check Recall Status
        const status = await getBotStatus(meeting_id);
        console.log(`[Status Request] ID: ${meeting_id}, Raw: ${status.raw_status}, Mapped: ${status.status}, Audio: ${status.audio_ready}`);
        res.json(status);

    } catch (error) {
        // Handle specific errors if needed
        if (error.response && error.response.status === 404) {
            return res.json({ status: 'processing', audio_ready: false, message: "Bot not found (might be initializing)" });
        }
        res.status(500).json({ error: error.message });
    }
});

// 3. Get Audio (Encrypted Stream)
app.get('/api/audio/:meeting_id', async (req, res) => {
    const { meeting_id } = req.params;
    const user_id = req.user.uid;

    const publicKeyPem = formatPEM(req.headers['x-public-key'] || process.env.FRONTEND_PUBLIC_KEY);

    if (!publicKeyPem) return res.status(400).json({ error: "Missing Public Key (header or env)" });

    try {
        // Verify ownership
        const record = await getMeeting(meeting_id);
        if (!record) return res.status(404).json({ error: "Meeting not found" });
        if (record.user_id !== user_id) return res.status(403).json({ error: "Unauthorized" });

        // Check Status / Get URL
        const status = await getBotStatus(meeting_id);
        if (!status.audio_ready || !status.audio_url) {
            return res.status(400).json({ error: "Audio not ready" });
        }

        console.log(`[Stream] Starting encrypted download for ${meeting_id}`);

        // 1. Get Audio Stream from Recall
        const audioStream = await downloadAudio(status.audio_url);

        // 2. Setup Encryption (AES Key/IV + RSA Encrypted Header)
        const { encryptedKeyHeader, cipher } = createEncryptionSetup(publicKeyPem);

        // 3. Set Headers and Pipe
        res.setHeader('X-Encrypted-Key', encryptedKeyHeader);
        res.setHeader('Content-Type', 'application/octet-stream');

        // Pipe: Recall Stream -> AES Cipher -> Response
        audioStream.pipe(cipher).pipe(res);

        audioStream.on('error', (err) => {
            console.error("Stream Error (Recall):", err);
            res.end(); // Close connection on error
        });

        cipher.on('error', (err) => {
            console.error("Stream Error (Encryption):", err);
            res.end();
        });

    } catch (error) {
        console.error("Handler Error:", error);
        // If headers haven't been sent, valid JSON error. If streaming started, connection just dies.
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
