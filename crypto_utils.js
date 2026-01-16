const crypto = require('crypto');
require('dotenv').config();

const MASTER_KEY_HEX = process.env.SERVER_MASTER_KEY;

if (!MASTER_KEY_HEX) {
    console.error("FATAL ERROR: SERVER_MASTER_KEY is missing in .env");
    process.exit(1);
}

const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, 'hex');

/**
 * Encrypts a Data Key using the Server Master Key (AES-256-GCM).
 * @param {Buffer|string} rawKey - The key to protect.
 * @returns {object} { encryptedBlob: string (hex), iv: string (hex), authTag: string (hex) }
 */
function protectKey(rawKey) {
    const iv = crypto.randomBytes(12); // GCM standard IV is 12 bytes
    const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);

    let encrypted = cipher.update(rawKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return {
        encryptedBlob: encrypted,
        iv: iv.toString('hex'),
        authTag: authTag
    };
}

/**
 * Decrypts a Data Key using the Server Master Key.
 * @param {string} encryptedBlobHex 
 * @param {string} ivHex 
 * @param {string} authTagHex 
 * @returns {Buffer} The raw key
 */
function unprotectKey(encryptedBlobHex, ivHex, authTagHex) {
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        MASTER_KEY,
        Buffer.from(ivHex, 'hex')
    );

    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    let decrypted = decipher.update(encryptedBlobHex, 'hex');
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted;
}

/**
 * Calculates SHA-256 Hash of string content.
 * @param {string} content 
 * @returns {string} Hex hash
 */
function calculateHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = { protectKey, unprotectKey, calculateHash };
