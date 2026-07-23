const { getMeetingKey } = require('./database');
const { getDecryptedStream } = require('./storage_enc');
const fs = require('fs');
const path = require('path');

async function viewTranscript(meetingId) {
    try {
        let output = `\n=== Viewing Transcript for ${meetingId} ===\n\n`;

        // Get decryption key
        const { key, iv } = await getMeetingKey(meetingId);
        if (!key) {
            console.error('❌ No encryption key found for this meeting');
            return;
        }

        // Decrypt transcript
        const transcriptPath = path.join(__dirname, 'storage_vault', 'data', `${meetingId}_transcript.enc`);
        if (!fs.existsSync(transcriptPath)) {
            console.error('❌ Transcript file not found');
            return;
        }

        const transcriptStream = getDecryptedStream(transcriptPath, key, iv);
        let transcriptData = '';

        transcriptStream.on('data', chunk => {
            transcriptData += chunk.toString();
        });

        transcriptStream.on('end', () => {
            output += '📄 TRANSCRIPT:\n';
            output += '─'.repeat(80) + '\n';
            try {
                const transcript = JSON.parse(transcriptData);
                output += `Full Text: ${transcript.text}\n\n`;
                output += '📝 Segments:\n';
                transcript.segments.forEach((seg, i) => {
                    output += `  ${i + 1}. [${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s] ${seg.speaker}: ${seg.text}\n`;
                });
            } catch (e) {
                output += `Raw data: ${transcriptData}\n`;
            }
            output += '─'.repeat(80) + '\n';

            // Now decrypt summary
            viewSummary(meetingId, key, iv, output);
        });

    } catch (error) {
        console.error('Error:', error.message);
    }
}

async function viewSummary(meetingId, key, iv, output) {
    try {
        const summaryPath = path.join(__dirname, 'storage_vault', 'data', `${meetingId}_summary.enc`);
        if (!fs.existsSync(summaryPath)) {
            console.error('❌ Summary file not found');
            return;
        }

        const summaryStream = getDecryptedStream(summaryPath, key, iv);
        let summaryData = '';

        summaryStream.on('data', chunk => {
            summaryData += chunk.toString();
        });

        summaryStream.on('end', () => {
            output += '\n📋 SUMMARY:\n';
            output += '─'.repeat(80) + '\n';
            try {
                const summary = JSON.parse(summaryData);
                output += `Summary: ${summary.summary}\n\n`;
                output += '✅ Action Items:\n';
                summary.actions.forEach((action, i) => {
                    output += `  ${i + 1}. ${action}\n`;
                });
            } catch (e) {
                output += `Raw data: ${summaryData}\n`;
            }
            output += '─'.repeat(80) + '\n';

            // Save to file
            fs.writeFileSync('transcript_output.txt', output);
            console.log(output);
            console.log('\n✅ Output saved to transcript_output.txt');
            process.exit(0);
        });

    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Get meeting ID from command line or use the one from logs
const meetingId = process.argv[2] || '2d183dde-8ba1-4227-b028-3efd96ae789c';
viewTranscript(meetingId);
