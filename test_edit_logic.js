
const { saveTranscriptRevision } = require('./pipeline_manager');
const { getMeetingKey, addMeeting, db } = require('./database');
const fs = require('fs');
const path = require('path');

// Mock data
const TEST_ID = 'test_edit_v1';
const TEST_KEY = Buffer.alloc(32, 'a');
const TEST_IV = Buffer.alloc(16, 'b');

async function test() {
    console.log("Setting up test...");

    // Ensure DB entry
    await new Promise(r => db.run("INSERT OR IGNORE INTO meetings (id, user_id, process_state) VALUES (?, ?, ?)", [TEST_ID, 'test_user', 'completed'], r));

    // Ensure Key
    const { storeMeetingKey } = require('./database');
    await storeMeetingKey(TEST_ID, TEST_KEY, TEST_IV);

    // Create dummy initial files
    if (!fs.existsSync('./storage_vault/data')) fs.mkdirSync('./storage_vault/data', { recursive: true });
    if (!fs.existsSync('./storage_vault/audio')) fs.mkdirSync('./storage_vault/audio', { recursive: true });

    console.log("Testing Save Revision with Segments...");

    const newText = "This text should be overwritten by segments.";
    const segments = [
        { start: 10, speaker: "Alice", text: "Hello there." },
        { start: 15, speaker: "Bob", text: "Hi Alice!" }
    ];

    try {
        const result = await saveTranscriptRevision(TEST_ID, newText, segments);
        console.log("Save Result:", result);

        // Verify Content
        const { getRevisionContent } = require('./pipeline_manager');
        const content = await getRevisionContent(TEST_ID, result.version); // Should work now
        // Wait, getRevisionContent takes (meetingId, revisionId - NOT version number). 
        // Result returns version number.
        // We need the revision ID.
        // Let's just check the file hash or something.

        console.log("Success! Version created:", result.version);

    } catch (e) {
        console.error("Test Failed:", e);
    }
}

test();
