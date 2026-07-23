const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Generates a random AES-256 Key and IV.
 */
function generateKeyIV() {
    return {
        key: crypto.randomBytes(32),
        iv: crypto.randomBytes(16)
    };
}

/**
 * Encrypts a stream into a specific file path.
 * @param {ReadableStream} inputStream 
 * @param {string} outputPath 
 * @param {Buffer} key 
 * @param {Buffer} iv 
 * @returns {Promise<void>}
 */
function encryptStreamToFile(inputStream, outputPath, key, iv) {
    return new Promise((resolve, reject) => {
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        const output = fs.createWriteStream(outputPath);

        inputStream.pipe(cipher).pipe(output);

        output.on('finish', () => resolve());
        output.on('error', (err) => reject(err));
        cipher.on('error', (err) => reject(err));
    });
}

/**
 * Decrypts a file from disk into a Readable Stream (Memory).
 * @param {string} inputPath 
 * @param {Buffer} key 
 * @param {Buffer} iv 
 * @returns {ReadableStream}
 */
function getDecryptedStream(inputPath, key, iv) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`File not found: ${inputPath}`);
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const input = fs.createReadStream(inputPath);

    return input.pipe(decipher);
}

/**
 * Helper to ensure storage directories exist.
 */
function ensureStorage() {
    const dirs = [
        path.join(__dirname, 'storage_vault'),
        path.join(__dirname, 'storage_vault', 'audio'),
        path.join(__dirname, 'storage_vault', 'data')
    ];
    dirs.forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
}

module.exports = {
    generateKeyIV,
    encryptStreamToFile,
    getDecryptedStream,
    ensureStorage
};
