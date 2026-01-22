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

        // 3. Hash and Versioning (TRANSCRIPT)
        const transcriptTextContent = transcriptJson.text || "";
        const transcriptHash = calculateHash(transcriptTextContent);

        // Save Version 1 Copy
        const transcriptV1Path = path.join(DATA_DIR, `${meetingId}_transcript_v1.enc`);
        await encryptBufferToFile(Buffer.from(JSON.stringify(transcriptJson)), transcriptV1Path, key, iv);

        // Save Version 1 to DB
        const { addRevision } = require('./database');
        db.run("INSERT INTO transcript_revisions (meeting_id, version, content_hash, file_path, type, edited_at) VALUES (?, ?, ?, ?, ?, ?)",
            [meetingId, 1, transcriptHash, transcriptV1Path, 'transcript', Date.now()]
        );

        // 4. Encrypt and Store Transcript (As JSON)
        const transcriptPath = path.join(DATA_DIR, `${meetingId}_transcript.enc`);
        await encryptBufferToFile(Buffer.from(JSON.stringify(transcriptJson)), transcriptPath, key, iv);

        console.log(`[Pipeline] Transcript Saved (Hash: ${transcriptHash.substring(0, 8)}).`);

        // 5. Run NLP (Summary)
        const summaryJson = await runSummary(transcriptJson.text);

        // 6. Encrypt Store Summary (Latest)
        const summaryPath = path.join(DATA_DIR, `${meetingId}_summary.enc`);
        await encryptBufferToFile(Buffer.from(JSON.stringify(summaryJson)), summaryPath, key, iv);

        // 6.5 Hash and Versioning (SUMMARY)
        const summaryTextContent = summaryJson.summary || "";
        const summaryHash = calculateHash(summaryTextContent);

        // Save Version 1 Copy
        const summaryV1Path = path.join(DATA_DIR, `${meetingId}_summary_v1.enc`);
        await encryptBufferToFile(Buffer.from(JSON.stringify(summaryJson)), summaryV1Path, key, iv);

        db.run("INSERT INTO transcript_revisions (meeting_id, version, content_hash, file_path, type, edited_at) VALUES (?, ?, ?, ?, ?, ?)",
            [meetingId, 1, summaryHash, summaryV1Path, 'summary', Date.now()]
        );

        console.log(`[Pipeline] Summary Saved (Hash: ${summaryHash.substring(0, 8)}).`);

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
async function saveTranscriptRevision(meetingId, newText, newSegments = []) {
    const { getLatestVersion, addRevision } = require('./database');
    const { calculateHash } = require('./crypto_utils');
    const { runSummary } = require('./nlp_local');

    try {
        const { key, iv } = await getMeetingKey(meetingId);
        if (!key) throw new Error("Meeting Key not found");

        // Hash the Text Content (consistent with processMeeting)
        const hash = calculateHash(newText);
        const currentVer = await getLatestVersion(meetingId, 'transcript');
        const newVer = currentVer + 1;

        // Construct JSON to preserve format
        // Use provided segments if available, otherwise we risk losing data.
        // If newSegments is empty (legacy call or simple text edit), we set it to [] but this is the issue user reported.
        // Frontend MUST send segments.
        const newJson = {
            text: newText,
            segments: newSegments
        };

        const buffer = Buffer.from(JSON.stringify(newJson));

        // 1. Overwrite the "Latest" file
        const transcriptPath = path.join(DATA_DIR, `${meetingId}_transcript.enc`);
        await encryptBufferToFile(buffer, transcriptPath, key, iv);

        // 2. Save Versioned Copy (for Revert)
        const versionedPath = path.join(DATA_DIR, `${meetingId}_transcript_v${newVer}.enc`);
        await encryptBufferToFile(buffer, versionedPath, key, iv);

        // Add History Record
        await addRevision(meetingId, newVer, hash, versionedPath, 'transcript');

        // --- SUMMARY UPDATE START ---
        console.log(`[Revision] Generating new summary for ${meetingId} v${newVer}...`);

        // Run NLP on new text
        const summaryJson = await runSummary(newText);
        const summaryHash = calculateHash(summaryJson.summary || "");

        // Save Latest Summary
        const summaryPath = path.join(DATA_DIR, `${meetingId}_summary.enc`);
        await encryptBufferToFile(Buffer.from(JSON.stringify(summaryJson)), summaryPath, key, iv);

        // Save Versioned Summary (Matched Version Number)
        const summaryVersionedPath = path.join(DATA_DIR, `${meetingId}_summary_v${newVer}.enc`);
        await encryptBufferToFile(Buffer.from(JSON.stringify(summaryJson)), summaryVersionedPath, key, iv);

        // Add History Record for Summary
        await addRevision(meetingId, newVer, summaryHash, summaryVersionedPath, 'summary');
        console.log(`[Revision] Summary updated and versioned (v${newVer}).`);
        // --- SUMMARY UPDATE END ---

        return { success: true, version: newVer, hash: hash };
    } catch (error) {
        console.error("Save Revision Error:", error);
        throw error;
    }
}

/**
 * Reads and combines Transcript and Summary into one JSON object.
 * Format matches Frontend expectations: { transcript: "...", summary: "..." }
 * Note: Frontend calls "text" as "transcript"
 */
async function getCombinedData(meetingId) {
    try {
        const { key, iv } = await getMeetingKey(meetingId);
        if (!key) throw new Error("Key not found");

        const transcriptPath = path.join(DATA_DIR, `${meetingId}_transcript.enc`);
        const summaryPath = path.join(DATA_DIR, `${meetingId}_summary.enc`);

        // Helper to read decrypted stream to string
        const readStream = (p) => {
            return new Promise((resolve, reject) => {
                if (!fs.existsSync(p)) return resolve(null);
                const stream = getDecryptedStream(p, key, iv);
                let data = '';
                stream.on('data', c => data += c.toString());
                stream.on('end', () => resolve(data));
                stream.on('error', reject);
            });
        };

        const [transcriptStr, summaryStr] = await Promise.all([
            readStream(transcriptPath),
            readStream(summaryPath)
        ]);

        let combined = { transcript: "", summary: null };

        if (transcriptStr) {
            try {
                const t = JSON.parse(transcriptStr);
                combined.transcript = t.text || ""; // Frontend expects 'transcript' string
                combined.segments = t.segments || []; // Add segments for Diarization UI
            } catch (e) {
                console.error("JSON Parse Error (Transcript):", e);
            }
        }

        if (summaryStr) {
            try {
                const s = JSON.parse(summaryStr);
                combined.summary = s; // Dashboard expects 'summary' object or string?
                // Dashboard: setSummary(data.summary || null);
                // Pipeline: runSummary returns { summary: "...", actions: [...] }
                // So this fits.
            } catch (e) {
                console.error("JSON Parse Error (Summary):", e);
            }
        }

        return combined;

    } catch (e) {
        throw e;
    }
}

const resumeProcessing = processMeeting;

async function revertToRevision(meetingId, revisionId) {
    const { getRevision, getRevisionByVersion } = require('./database'); // Need getRevisionByVersion
    const { getMeetingKey } = require('./database');

    try {
        const revision = await getRevision(revisionId);
        if (!revision) throw new Error("Revision not found");
        if (revision.meeting_id !== meetingId) throw new Error("Revision mismatch");

        // We only support reverting Transcripts for now as Summaries are not editable
        if (revision.type !== 'transcript') throw new Error("Only transcripts can be reverted");

        const { key, iv } = await getMeetingKey(meetingId);
        if (!key) throw new Error("Key not found");

        if (!fs.existsSync(revision.file_path)) throw new Error("Revision file missing");

        // Decrypt old version (TARGET version to revert TO)
        const stream = getDecryptedStream(revision.file_path, key, iv);
        let data = '';
        await new Promise((resolve, reject) => {
            stream.on('data', c => data += c.toString());
            stream.on('end', resolve);
            stream.on('error', reject);
        });

        const oldJson = JSON.parse(data);
        const oldText = oldJson.text;
        const oldSegments = oldJson.segments || []; // Restore segments!

        console.log(`[Revert] Restoring Transcript v${revision.version} as new version...`);

        // Create NEW revision with OLD content (Transcript)
        // This will create v(N+1) with content of v(Target)
        // And it will ALSO trigger summary generation/update
        const result = await saveTranscriptRevision(meetingId, oldText, oldSegments);

        // OPTIMIZATION: Instead of re-generating summary (which is slow), check if we have the old summary version
        // and copy THAT instead.
        // However, saveTranscriptRevision already triggered runSummary. Ideally we'd pass a flag to skip summary gen
        // if we want to manually restore the old one. 
        // Given current robust implementation, let's let runSummary run (ensures consistency) 
        // OR we can overwrite it if we find the old one.

        // Let's try to find the matching summary version
        // If we reverted TO version X, we want Summary Version X.
        // But saveTranscriptRevision just made verified Summary Version Y (based on Text X).
        // Since Text X generates Summary X (deterministically-ish), it's fine.
        // But to be EXACT (user said "summary change according to transcript"), regenerating is safest.

        return result;

    } catch (error) {
        console.error("Revert Error:", error);
        throw error;
    }
}

async function getRevisionContent(meetingId, revisionId) {
    const { getRevision, getMeetingKey } = require('./database');
    try {
        const revision = await getRevision(revisionId);
        if (!revision) throw new Error("Revision not found");
        if (revision.meeting_id !== meetingId) throw new Error("Revision mismatch");

        // Assuming both transcript and summary revisions are stored similarly now?
        // Wait, summaries are stored in 'transcript_revisions' with type='summary' but do they point to a versioned file?
        // Yes, processMeeting saves them.

        const { key, iv } = await getMeetingKey(meetingId);
        if (!key) throw new Error("Key not found");

        if (!fs.existsSync(revision.file_path)) return null;

        const stream = getDecryptedStream(revision.file_path, key, iv);
        let data = '';
        await new Promise((resolve, reject) => {
            stream.on('data', c => data += c.toString());
            stream.on('end', resolve);
            stream.on('error', reject);
        });

        const json = JSON.parse(data);
        return json; // Returns { text: "...", segments: ... } or { summary: "..." }
    } catch (error) {
        console.error("GetContent Error:", error);
        return null;
    }
}

module.exports = { ingestRecording, processMeeting, resumeProcessing, getArtifactStream, saveTranscriptRevision, getCombinedData, revertToRevision, getRevisionContent };
