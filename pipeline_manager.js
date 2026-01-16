const fs = require('fs');
const path = require('path');
const os = require('os');
const { encryptStreamToFile, getDecryptedStream, generateKeyIV, ensureStorage } = require('./storage_enc');
const { storeMeetingKey, getMeetingKey, updateProcessState, db } = require('./database');
const { runWhisper } = require('./transcribe_local');
const { runSummary } = require('./nlp_local');
const { calculateHash } = require('./crypto_utils');
const ffmpeg = require('fluent-ffmpeg');
const { PassThrough } = require('stream');

// Puts files in ./storage_vault/
const STORAGE_ROOT = path.join(__dirname, 'storage_vault');
const AUDIO_DIR = path.join(STORAGE_ROOT, 'audio');
const DATA_DIR = path.join(STORAGE_ROOT, 'data');

ensureStorage();

/**
 * Pipeline Step 1: Ingest and Protect.
 * Takes a stream (from Recall), converts to MP3, encrypts it, and saves to disk.
 */
async function ingestRecording(meetingId, audioStream) {
    console.log(`[Pipeline] Ingesting & Converting ${meetingId}...`);

    const { key, iv } = generateKeyIV();
    const filePath = path.join(AUDIO_DIR, `${meetingId}.enc`);

    // Create a PassThrough stream to capture FFmpeg output
    const mp3Stream = new PassThrough();

    // Start FFmpeg Conversion (MP4/WebM -> MP3)
    ffmpeg(audioStream)
        .format('mp3')
        .audioCodec('libmp3lame')
        .on('error', (err) => console.error(`[FFmpeg Error] ${meetingId}:`, err.message))
        .pipe(mp3Stream);

    // Encrypt the MP3 stream to disk
    await encryptStreamToFile(mp3Stream, filePath, key, iv);

    // Store credentials securely (treating 'iv' as the File IV)
    await storeMeetingKey(meetingId, key, iv);

    await updateProcessState(meetingId, 'downloaded');

    console.log(`[Pipeline] Saved Encrypted Audio (MP3): ${filePath}`);

    // Trigger Async Processing
    processMeeting(meetingId).catch(err => console.error(`[Pipeline Error] ${meetingId}:`, err));

    return { success: true };
}

/**
 * Pipeline Step 2 & 3: Transcribe and Analyze (Async)
 */
async function processMeeting(meetingId) {
    try {
        console.log(`[Pipeline] Processing ${meetingId}...`);
        await updateProcessState(meetingId, 'transcribing');

        // 1. Decrypt Audio to Temp File for Whisper
        const { key, iv } = await getMeetingKey(meetingId);
        const encAudioPath = path.join(AUDIO_DIR, `${meetingId}.enc`);

        // Since we force-converted to MP3 during ingest, we know it's MP3.
        const tempAudioPath = path.join(os.tmpdir(), `${meetingId}_temp.mp3`);
        const outputStream = fs.createWriteStream(tempAudioPath);

        const decryptStream = getDecryptedStream(encAudioPath, key, iv);

        await new Promise((resolve, reject) => {
            decryptStream.pipe(outputStream);
            outputStream.on('finish', resolve);
            outputStream.on('error', reject);
        });

        // 2. Run Whisper
        const transcriptJson = await runWhisper(tempAudioPath);

        // 2.5 Capture Duration (while temp file exists)
        let durationSeconds = 0;
        try {
            durationSeconds = await new Promise((resolve) => {
                ffmpeg.ffprobe(tempAudioPath, (err, metadata) => {
                    if (err) {
                        console.error(`[ffprobe] Failed to get duration:`, err.message);
                        resolve(0);
                    } else {
                        resolve(Math.round(metadata.format.duration || 0));
                    }
                });
            });
            console.log(`[Pipeline] Duration captured: ${durationSeconds}s`);
        } catch (e) {
            console.error(`[Pipeline] Duration error:`, e);
        }

        // Cleanup Temp Audio IMMEDIATELY
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);

        // 3. Hash and Versioning
        const transcriptText = JSON.stringify(transcriptJson);
        const transcriptHash = calculateHash(transcriptText);

        // Save Version 1 to DB
        db.run("INSERT INTO transcript_revisions (meeting_id, version, content_hash, file_path, edited_at) VALUES (?, ?, ?, ?, ?)",
            [meetingId, 1, transcriptHash, 'internal_storage', Date.now()]
        );

        // 4. Encrypt and Store Transcript
        const transcriptPath = path.join(DATA_DIR, `${meetingId}_transcript.enc`);
        await encryptBufferToFile(Buffer.from(transcriptText), transcriptPath, key, iv);

        console.log(`[Pipeline] Transcript Saved.`);

        // 5. Run NLP (Summary)
        const summaryJson = await runSummary(transcriptJson.text);

        // 6. Encrypt Store Summary
        const summaryPath = path.join(DATA_DIR, `${meetingId}_summary.enc`);
        await encryptBufferToFile(Buffer.from(JSON.stringify(summaryJson)), summaryPath, key, iv);

        console.log(`[Pipeline] Summary Saved.`);

        // Complete
        await updateProcessState(meetingId, 'completed', {
            audio: encAudioPath,
            transcript: transcriptPath,
            summary: summaryPath
        }, durationSeconds); // Pass captured duration

    } catch (error) {
        console.error(`[Pipeline Error] Processing failed for ${meetingId}`, error);
        await updateProcessState(meetingId, 'failed');
    }
}

// Helper to encrypt buffer (simulating stream for storage_enc compatibility)
function encryptBufferToFile(buffer, outputPath, key, iv) {
    const crypto = require('crypto');
    return new Promise((resolve, reject) => {
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        const output = fs.createWriteStream(outputPath);

        output.write(cipher.update(buffer));
        output.write(cipher.final());
        output.end();

        output.on('finish', resolve);
        output.on('error', reject);
    });
}

/**
 * Returns a readable stream of the Decrypted Data (Audio/JSON).
 * Used by server.js to stream to frontend.
 */
function getArtifactStream(meetingId, type) {
    return new Promise(async (resolve, reject) => {
        try {
            const { key, iv } = await getMeetingKey(meetingId); // Reusing Audio Key for all assets
            if (!key) return reject(new Error("Key not found"));

            let filePath;
            if (type === 'audio') filePath = path.join(AUDIO_DIR, `${meetingId}.enc`);
            else if (type === 'transcript') filePath = path.join(DATA_DIR, `${meetingId}_transcript.enc`);
            else if (type === 'summary') filePath = path.join(DATA_DIR, `${meetingId}_summary.enc`);
            else return reject(new Error("Invalid artifact type"));

            if (!fs.existsSync(filePath)) return reject(new Error("File not found"));

            // Return the Decrypted Stream (Disk -> Cipher -> Stream)
            // Wait, getDecryptedStream returns a Decipher stream (Encrypted Disk -> Clear Stream)
            resolve(getDecryptedStream(filePath, key, iv));
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * REVISION LOGIC:
 * 1. Calculate Hash.
 * 2. Get Next Version.
 * 3. Encrypt & Overwrite `transcript.enc`.
 * 4. Add DB Entry.
 */
async function saveTranscriptRevision(meetingId, newText) {
    const { getLatestVersion, addRevision } = require('./database');
    const { calculateHash } = require('./crypto_utils');

    try {
        const { key, iv } = await getMeetingKey(meetingId);
        if (!key) throw new Error("Meeting Key not found");

        const hash = calculateHash(newText);
        const currentVer = await getLatestVersion(meetingId);
        const newVer = currentVer + 1;

        // Overwrite the "Latest" file
        const transcriptPath = path.join(DATA_DIR, `${meetingId}_transcript.enc`);
        await encryptBufferToFile(Buffer.from(newText), transcriptPath, key, iv);

        // Add History Record
        await addRevision(meetingId, newVer, hash, 'internal_storage');

        return { success: true, version: newVer, hash: hash };
    } catch (error) {
        console.error("Save Revision Error:", error);
        throw error;
    }
}

const resumeProcessing = processMeeting;

module.exports = { ingestRecording, processMeeting, resumeProcessing, getArtifactStream, saveTranscriptRevision };
