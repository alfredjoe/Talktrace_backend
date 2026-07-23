const crypto = require('crypto');


/**
 * Prepares for streaming encryption.
 * Generates AES Key/IV, encrypts them with RSA Public Key, and returns the Cipher.
 * 
 * @param {string} publicKeyPem 
 * @returns {object} { encryptedKeyHeader, cipher }
 */
function createEncryptionSetup(publicKeyPem) {
    try {
        // 1. Generate AES Key (32 bytes) and IV (16 bytes)
        const aesKey = crypto.randomBytes(32);
        const iv = crypto.randomBytes(16);

        console.log("Encryption using Public Key (First 50 chars):", publicKeyPem.substring(0, 50) + "...");




        // 2. Encrypt AES Key and IV with RSA Public Key (OAEP Padding)
        // keyData format: [AES_KEY (32)] + [IV (16)]
        const keyData = Buffer.concat([aesKey, iv]);

        const encryptedKeyData = crypto.publicEncrypt(
            {
                key: publicKeyPem,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: "sha256",
            },
            keyData
        );

        // 3. Create AES Cipher Stream
        const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);

        return {
            encryptedKeyHeader: encryptedKeyData.toString('base64'),
            cipher: cipher
        };

    } catch (error) {
        console.error("Encryption Setup Error:", error);
        throw error;
    }
}

/**
 * Format a PEM string by fixing newlines and quotes.
 * @param {string} pem 
 * @returns {string}
 */
/**
 * Format a PEM string by fixing newlines and ensuring correct structure.
 * Handles cases where newline characters are escaped or missing.
 * @param {string} pem 
 * @returns {string}
 */
function formatPEM(pem) {
    if (!pem) return pem;

    // 1. Clean basic string issues
    let clean = pem.toString().trim();
    if (clean.startsWith('"') && clean.endsWith('"')) {
        clean = clean.slice(1, -1);
    }

    // 2. Replace literal escaped newlines
    if (clean.includes('\\n')) {
        clean = clean.replace(/\\n/g, '\n');
    }

    // 3. If it already looks formatted (has multiple lines), return as is
    if (clean.split('\n').length > 1) {
        return clean;
    }

    // 4. Handle "Flat" PEM (single line header+body+footer) caused by HTTP headers
    // Remove existing headers to isolate the body
    const header = "-----BEGIN PUBLIC KEY-----";
    const footer = "-----END PUBLIC KEY-----";

    let body = clean;
    if (body.includes(header)) body = body.replace(header, '');
    if (body.includes(footer)) body = body.replace(footer, '');

    body = body.replace(/\s/g, ''); // Remove all whitespace

    // 5. Chunk body into 64-char lines (Standard PEM format)
    const chunkedBody = body.match(/.{1,64}/g).join('\n');

    return `${header}\n${chunkedBody}\n${footer}`;
}

module.exports = { createEncryptionSetup, formatPEM };
