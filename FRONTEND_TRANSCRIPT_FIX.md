# Frontend Alignment Guide - Transcript/Summary Display Issue

## Problem Analysis

Based on the screenshot and logs:
- ✅ Backend successfully generated transcript and summary
- ✅ Audio decryption works perfectly
- ❌ Frontend shows "Error loading data: Fetch data failed" for transcript
- ❌ Logs show "Fetching secure transcript..." but then fails

## Root Cause

The issue is likely one of the following:

### 1. **Content-Type Mismatch**
The backend sends `Content-Type: application/json` for transcript/summary, but the encrypted data is binary. The frontend might be trying to parse it as JSON before decryption.

### 2. **Decryption Logic Difference**
Audio decryption works, but transcript decryption fails. This suggests:
- The frontend might be using different decryption logic for JSON vs audio
- The transcript might be parsed as JSON before decryption (wrong order)

### 3. **Response Handling**
The frontend might be expecting a different response format for transcript/summary.

---

## Frontend Code to Check

### Issue 1: Parsing Before Decryption ❌

**WRONG**:
```javascript
// DON'T parse as JSON first!
const response = await fetch(`/api/data/${meetingId}/transcript`);
const json = await response.json(); // ❌ This will fail - data is encrypted binary!
```

**CORRECT**:
```javascript
// Get as ArrayBuffer, decrypt, THEN parse
const response = await fetch(`/api/data/${meetingId}/transcript`);
const encryptedData = await response.arrayBuffer(); // ✅ Binary data
// ... decrypt ...
const decryptedText = decipher.output.toString();
const json = JSON.parse(decryptedText); // ✅ Parse AFTER decryption
```

---

### Issue 2: Content-Type Handling

The frontend might be checking `Content-Type: application/json` and trying to auto-parse. 

**Check your fetch code**:
```javascript
// If you're using this pattern, it will fail:
const data = await response.json(); // ❌ Encrypted data is not JSON!

// Use this instead:
const encryptedBuffer = await response.arrayBuffer(); // ✅
```

---

### Issue 3: Missing Error Details

The frontend logs show "Fetch data failed" but no details. Add better error logging:

```javascript
async function fetchTranscript(meetingId) {
  try {
    console.log('[Frontend] Fetching transcript for', meetingId);
    
    const response = await fetch(`${API_BASE_URL}/data/${meetingId}/transcript`, {
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'X-Public-Key': publicKeyPem
      }
    });

    console.log('[Frontend] Response status:', response.status);
    console.log('[Frontend] Response headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Frontend] Error response:', errorText);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    // Get encrypted data as ArrayBuffer
    const encryptedData = await response.arrayBuffer();
    console.log('[Frontend] Encrypted data size:', encryptedData.byteLength);

    // Get encrypted key from header
    const encryptedKeyHeader = response.headers.get('X-Encrypted-Key');
    if (!encryptedKeyHeader) {
      throw new Error('Missing X-Encrypted-Key header');
    }

    console.log('[Frontend] Encrypted key header:', encryptedKeyHeader.substring(0, 50) + '...');

    // Decrypt (same as audio)
    const [encKeyB64, ivB64] = encryptedKeyHeader.split(':');
    const aesKey = privateKey.decrypt(forge.util.decode64(encKeyB64), 'RSA-OAEP');
    const iv = forge.util.decode64(ivB64);

    const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
    decipher.start({ iv: iv });
    decipher.update(forge.util.createBuffer(encryptedData));
    
    if (!decipher.finish()) {
      throw new Error('Decryption failed - authentication tag mismatch');
    }

    const decryptedText = decipher.output.toString();
    console.log('[Frontend] Decrypted text length:', decryptedText.length);
    console.log('[Frontend] Decrypted text preview:', decryptedText.substring(0, 100));

    // Parse JSON
    const json = JSON.parse(decryptedText);
    console.log('[Frontend] Parsed JSON:', json);

    return json;

  } catch (error) {
    console.error('[Frontend] Transcript fetch error:', error);
    console.error('[Frontend] Error stack:', error.stack);
    throw error;
  }
}
```

---

## Specific Frontend Changes Needed

### 1. Check Dashboard.js - `fetchTranscript` function

Look for code like this and fix it:

**BEFORE** (likely causing the issue):
```javascript
async fetchTranscript() {
  const response = await fetch(`/api/data/${meetingId}/transcript`, {
    headers: { 'X-Public-Key': this.publicKey }
  });
  
  const data = await response.json(); // ❌ WRONG - data is encrypted!
  // ... decryption code ...
}
```

**AFTER** (correct):
```javascript
async fetchTranscript() {
  const response = await fetch(`/api/data/${meetingId}/transcript`, {
    headers: { 'X-Public-Key': this.publicKey }
  });
  
  const encryptedData = await response.arrayBuffer(); // ✅ Get binary data
  
  // Decrypt first
  const encryptedKeyHeader = response.headers.get('X-Encrypted-Key');
  const [encKeyB64, ivB64] = encryptedKeyHeader.split(':');
  const aesKey = this.privateKey.decrypt(forge.util.decode64(encKeyB64), 'RSA-OAEP');
  const iv = forge.util.decode64(ivB64);
  
  const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
  decipher.start({ iv: iv });
  decipher.update(forge.util.createBuffer(encryptedData));
  decipher.finish();
  
  // THEN parse JSON
  const decryptedText = decipher.output.toString();
  const json = JSON.parse(decryptedText); // ✅ Parse after decryption
  
  return json;
}
```

---

### 2. Unified Decryption Helper

Create a single helper function for all decryption:

```javascript
async function decryptResponse(response, privateKey) {
  // Get encrypted data
  const encryptedData = await response.arrayBuffer();
  
  // Get encrypted AES key from header
  const encryptedKeyHeader = response.headers.get('X-Encrypted-Key');
  if (!encryptedKeyHeader) {
    throw new Error('Missing X-Encrypted-Key header');
  }
  
  const [encKeyB64, ivB64] = encryptedKeyHeader.split(':');
  
  // Decrypt AES key with RSA
  const aesKey = privateKey.decrypt(
    forge.util.decode64(encKeyB64), 
    'RSA-OAEP'
  );
  const iv = forge.util.decode64(ivB64);
  
  // Decrypt data with AES
  const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
  decipher.start({ iv: iv });
  decipher.update(forge.util.createBuffer(encryptedData));
  
  if (!decipher.finish()) {
    throw new Error('Decryption failed');
  }
  
  return decipher.output;
}

// Usage:
async function fetchTranscript(meetingId) {
  const response = await fetch(`/api/data/${meetingId}/transcript`, {
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'X-Public-Key': publicKeyPem
    }
  });
  
  const decryptedBuffer = await decryptResponse(response, privateKey);
  const json = JSON.parse(decryptedBuffer.toString());
  return json;
}

async function fetchSummary(meetingId) {
  const response = await fetch(`/api/data/${meetingId}/summary`, {
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'X-Public-Key': publicKeyPem
    }
  });
  
  const decryptedBuffer = await decryptResponse(response, privateKey);
  const json = JSON.parse(decryptedBuffer.toString());
  return json;
}

async function fetchAudio(meetingId) {
  const response = await fetch(`/api/audio/${meetingId}`, {
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'X-Public-Key': publicKeyPem
    }
  });
  
  const decryptedBuffer = await decryptResponse(response, privateKey);
  const audioBlob = new Blob([decryptedBuffer.getBytes()], { type: 'audio/mpeg' });
  return URL.createObjectURL(audioBlob);
}
```

---

## Testing Steps

1. **Add detailed logging** to your frontend transcript fetch function
2. **Open browser console** and check for:
   - Response status (should be 200)
   - Response headers (should have `X-Encrypted-Key`)
   - Encrypted data size (should be > 0)
   - Decryption errors
3. **Compare** with audio fetch (which works) to see the difference

---

## Expected Backend Response

When you request `/api/data/:meeting_id/transcript`, the backend returns:

**Headers**:
```
Content-Type: application/json
X-Encrypted-Key: <base64-encrypted-key>:<base64-iv>
```

**Body**: Binary encrypted data (NOT JSON text!)

The frontend must:
1. Read as `ArrayBuffer` (not `.json()`)
2. Decrypt the binary data
3. Convert to string
4. Parse as JSON

---

## Quick Fix Checklist

- [ ] Change `response.json()` to `response.arrayBuffer()` for transcript/summary
- [ ] Ensure decryption happens BEFORE JSON.parse()
- [ ] Use the same decryption logic as audio (it works!)
- [ ] Add console.log statements to see where it fails
- [ ] Check browser console for actual error messages

---

## If Still Failing

Share the **exact frontend code** for:
1. `fetchTranscript()` function
2. `fetchSummary()` function
3. Browser console error messages (full stack trace)

The backend is working perfectly - this is purely a frontend decryption/parsing issue.
