const crypto = require('crypto');
const NodeRSA = require('node-rsa');
const { createEncryptionSetup } = require('./encryption');
const { Readable } = require('stream');

console.log("--> Starting Streaming Encryption Test...");

// 1. Generate Test Key Pair
const key = new NodeRSA({ b: 2048 });
const publicKey = key.exportKey('pkcs8-public');
const privateKey = key.exportKey('pkcs8-private');

console.log("Generated 2048-bit RSA Key Pair.");

// 2. Mock Audio Stream
const originalText = "This is a stream of secret audio data... 1234567890";
const originalData = Buffer.from(originalText);
const inputStream = Readable.from([originalData]);

// 3. Encrypt (Backend Logic)
console.log("Encrypting Stream...");
const { encryptedKeyHeader, cipher } = createEncryptionSetup(publicKey);

const encryptedChunks = [];
const encryptionPromise = new Promise((resolve, reject) => {
    inputStream.pipe(cipher)
        .on('data', chunk => encryptedChunks.push(chunk))
        .on('end', resolve)
        .on('error', reject);
});

encryptionPromise.then(() => {
    const encryptedBody = Buffer.concat(encryptedChunks);
    console.log("Encrypted Header (Base64 length):", encryptedKeyHeader.length);
    console.log("Encrypted Body (Bytes):", encryptedBody.length);

    // 4. Decrypt (Frontend Logic)
    console.log("Decrypting...");

    // 4a. Decrypt AES Key from Header (Native Crypto with OAEP)
    const decryptedKeyData = crypto.privateDecrypt(
        {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
        },
        Buffer.from(encryptedKeyHeader, 'base64')
    );

    const aesKey = decryptedKeyData.slice(0, 32);
    const iv = decryptedKeyData.slice(32, 48);

    // 4b. Decrypt Body (Simulating stream or blob decryption)
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);

    const decryptedChunks = [];
    decryptedChunks.push(decipher.update(encryptedBody));
    decryptedChunks.push(decipher.final());

    const decryptedBuffer = Buffer.concat(decryptedChunks);
    console.log("Decrypted Data:", decryptedBuffer.toString());

    if (decryptedBuffer.equals(originalData)) {
        console.log("--> SUCCESS: Decrypted stream matches original!");
    } else {
        console.error("--> FAILURE: Data mismatch.");
    }
}).catch(err => {
    console.error("Test Failed:", err);
});
