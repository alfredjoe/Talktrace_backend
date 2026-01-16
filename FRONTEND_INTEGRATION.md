# Talktrace Backend - Frontend Integration Guide

## Base Configuration

```javascript
const API_BASE_URL = 'http://localhost:3002/api';
```

---

## Authentication

All API endpoints require Firebase JWT authentication via the `Authorization` header.

```javascript
// Get Firebase ID Token
const idToken = await firebase.auth().currentUser.getIdToken();

// Include in all requests
headers: {
  'Authorization': `Bearer ${idToken}`,
  'Content-Type': 'application/json'
}
```

---

## API Endpoints

### 1. Join Meeting

**Endpoint**: `POST /api/join`

**Request**:
```javascript
const response = await fetch(`${API_BASE_URL}/join`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${idToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    bot_name: 'Talktrace Bot' // Optional
  })
});

const data = await response.json();
// { success: true, meeting_id: "abc123...", message: "Bot joined successfully." }
```

**Response**:
- `200`: `{ success: true, meeting_id: string, message: string }`
- `400`: `{ error: "Missing meeting_url" }`
- `500`: `{ error: string, details: object }`

---

### 2. Leave Meeting

**Endpoint**: `POST /api/leave`

**Request**:
```javascript
await fetch(`${API_BASE_URL}/leave`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${idToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    meeting_id: 'abc123...'
  })
});
```

**Response**:
- `200`: `{ success: true }`
- `500`: `{ error: string }`

---

### 3. Get Meeting Status (Polling)

**Endpoint**: `GET /api/status/:meeting_id`

**Request**:
```javascript
const response = await fetch(`${API_BASE_URL}/status/${meetingId}`, {
  headers: {
    'Authorization': `Bearer ${idToken}`
  }
});

const status = await response.json();
```

**Response States**:

#### Processing
```json
{
  "status": "processing",
  "audio_ready": false,
  "timestamp": 1234567890
}
```

#### Downloaded
```json
{
  "status": "downloaded",
  "process_state": "downloaded",
  "audio_ready": true,
  "timestamp": 1234567890
}
```

#### Transcribing
```json
{
  "status": "transcribing",
  "process_state": "transcribing",
  "audio_ready": true,
  "timestamp": 1234567890
}
```

#### Complete
```json
{
  "status": "complete",
  "raw_status": "completed",
  "process_state": "completed",
  "audio_ready": true,
  "timestamp": 1234567890,
  "artifacts": {
    "audio": "/path/to/audio.enc",
    "transcript": "/path/to/transcript.enc",
    "summary": "/path/to/summary.enc"
  }
}
```

#### Discarded (No Audio)
```json
{
  "status": "discarded",
  "message": "Meeting ended with no audio recorded. Session discarded."
}
```

**Frontend Handling**:
```javascript
if (status.status === 'discarded') {
  // Stop polling
  clearInterval(pollInterval);
  // Remove from UI
  removeMeetingCard(meetingId);
  // Show notification
  showToast('Meeting discarded (no audio recorded)');
}
```

---

### 4. Get User Meetings (Library)

**Endpoint**: `GET /api/meetings`

**Request**:
```javascript
const response = await fetch(`${API_BASE_URL}/meetings`, {
  headers: {
    'Authorization': `Bearer ${idToken}`
  }
});

const data = await response.json();
```

**Response**:
```json
{
  "success": true,
  "meetings": [
    {
      "id": "abc123...",
      "meeting_id": "abc123...",
      "user_id": "firebase-uid",
      "bot_id": "abc123...",
      "status": "completed",
      "process_state": "completed",
      "created_at": 1234567890,
      "duration": "00:29",
      "date": "1/16/2026"
    }
  ]
}
```

---

### 5. Download & Decrypt Audio

**Endpoint**: `GET /api/audio/:meeting_id`

**Request**:
```javascript
async function downloadAndDecryptAudio(meetingId, privateKey) {
  const response = await fetch(`${API_BASE_URL}/audio/${meetingId}`, {
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'X-Public-Key': publicKeyPem // RSA public key
    }
  });

  // Get encrypted AES key from header
  const encryptedKeyHeader = response.headers.get('X-Encrypted-Key');
  const [encKeyB64, ivB64] = encryptedKeyHeader.split(':');

  // Decrypt AES key with RSA private key
  const aesKey = privateKey.decrypt(forge.util.decode64(encKeyB64), 'RSA-OAEP');
  const iv = forge.util.decode64(ivB64);

  // Read encrypted stream
  const encryptedData = await response.arrayBuffer();

  // Decrypt with AES
  const decipher = forge.cipher.createDecipher('AES-CBC', aesKey);
  decipher.start({ iv: iv });
  decipher.update(forge.util.createBuffer(encryptedData));
  decipher.finish();

  // Create audio blob
  const audioBlob = new Blob([decipher.output.getBytes()], { type: 'audio/mpeg' });
  return URL.createObjectURL(audioBlob);
}
```

---

### 6. Download & Decrypt Transcript

**Endpoint**: `GET /api/data/:meeting_id/transcript`

**Request**: Same as audio, but returns JSON

**Response** (decrypted):
```json
{
  "text": "Full transcript text...",
  "segments": [
    {
      "start": 0,
      "end": 5.2,
      "text": "Hello everyone",
      "speaker": "Speaker 1"
    }
  ]
}
```

**Frontend Handling**:
```javascript
async function fetchTranscript(meetingId) {
  try {
    const response = await fetch(`${API_BASE_URL}/data/${meetingId}/transcript`, {
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'X-Public-Key': publicKeyPem
      }
    });

    if (response.status === 404) {
      showMessage("Transcript not available yet. Processing may still be in progress.");
      return null;
    }

    if (!response.ok) {
      throw new Error('Failed to fetch transcript');
    }

    // Decrypt and parse
    const decryptedJson = await decryptResponse(response, privateKey);
    return JSON.parse(decryptedJson);

  } catch (error) {
    console.error('Transcript fetch error:', error);
    showMessage("Failed to load transcript. Please try again.");
    return null;
  }
}
```

---

### 7. Download & Decrypt Summary

**Endpoint**: `GET /api/data/:meeting_id/summary`

**Response** (decrypted):
```json
{
  "summary": "Meeting summary text...",
  "actions": [
    "Action item 1",
    "Action item 2"
  ]
}
```

---

### 8. Edit Transcript

**Endpoint**: `POST /api/edit/:meeting_id`

**Request**:
```javascript
await fetch(`${API_BASE_URL}/edit/${meetingId}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${idToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    text: 'Updated transcript text...'
  })
});
```

**Response**:
```json
{
  "success": true,
  "message": "Transcript updated successfully",
  "version": 2,
  "hash": "sha256-hash..."
}
```

---

### 9. Verify Transcript Integrity

**Endpoint**: `POST /api/verify`

**Request**:
```javascript
// Calculate SHA-256 hash of transcript
const hash = await crypto.subtle.digest('SHA-256', 
  new TextEncoder().encode(transcriptText)
);
const hashHex = Array.from(new Uint8Array(hash))
  .map(b => b.toString(16).padStart(2, '0'))
  .join('');

const response = await fetch(`${API_BASE_URL}/verify`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${idToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ hash: hashHex })
});
```

**Response**:
```json
{
  "verified": true,
  "meeting_id": "abc123...",
  "version": 1,
  "date": 1234567890,
  "message": "✅ Verified: Matches Version 1"
}
```

---

### 10. Retry Processing

**Endpoint**: `POST /api/retry/:meeting_id`

**Request**:
```javascript
await fetch(`${API_BASE_URL}/retry/${meetingId}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${idToken}`
  }
});
```

**Response**:
```json
{
  "success": true,
  "message": "Processing started/resumed."
}
```

---

### 11. Delete Meeting (NEW)

**Endpoint**: `DELETE /api/meeting/:meeting_id`

**Request**:
```javascript
async function deleteMeeting(meetingId) {
  const confirmed = confirm('Are you sure you want to delete this meeting? This action cannot be undone.');
  
  if (!confirmed) return;

  try {
    const response = await fetch(`${API_BASE_URL}/meeting/${meetingId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });

    const data = await response.json();

    if (response.ok) {
      // Remove from UI
      removeMeetingCard(meetingId);
      showToast('Meeting deleted successfully');
    } else {
      showToast(`Error: ${data.error}`);
    }

  } catch (error) {
    console.error('Delete error:', error);
    showToast('Failed to delete meeting');
  }
}
```

**Response**:
- `200`: `{ success: true, message: "Meeting deleted successfully." }`
- `404`: `{ error: "Meeting not found" }`
- `403`: `{ error: "Unauthorized" }`
- `500`: `{ error: string }`

**UI Integration**:
```jsx
// Add delete button to meeting card
<button onClick={() => deleteMeeting(meeting.meeting_id)}>
  🗑️ Delete
</button>
```

---

## Security Notes

### Level 2 (Managed) Security

1. **Crypto-Shredding**: When a meeting is deleted (via DELETE endpoint or auto-discard), the encryption keys are destroyed, making the encrypted files permanently unrecoverable.

2. **Client-Side Decryption**: All data is encrypted on the server. The client receives encrypted streams and must decrypt them using the RSA private key (generated client-side).

3. **Key Exchange**: 
   - Client generates RSA key pair per session
   - Public key sent via `X-Public-Key` header
   - Server encrypts AES key with client's public key
   - Only client can decrypt with private key

4. **Zero-Knowledge**: Server cannot read transcript/summary content (encrypted at rest).

---

## Error Handling

```javascript
async function apiCall(endpoint, options) {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${await getIdToken()}`,
        ...options.headers
      }
    });

    if (response.status === 401) {
      // Token expired, refresh
      await firebase.auth().currentUser.getIdToken(true);
      return apiCall(endpoint, options); // Retry
    }

    if (response.status === 403) {
      showToast('Unauthorized access');
      return null;
    }

    if (response.status === 404) {
      return null; // Handle as "not found"
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'API request failed');
    }

    return response;

  } catch (error) {
    console.error('API Error:', error);
    showToast('Network error. Please try again.');
    return null;
  }
}
```

---

## Complete Example: Meeting Lifecycle

```javascript
// 1. Join meeting
const { meeting_id } = await joinMeeting(meetingUrl);

// 2. Poll for status
const pollInterval = setInterval(async () => {
  const status = await getMeetingStatus(meeting_id);
  
  if (status.status === 'discarded') {
    clearInterval(pollInterval);
    removeMeetingCard(meeting_id);
    showToast('Meeting discarded (no audio)');
    return;
  }
  
  if (status.status === 'complete') {
    clearInterval(pollInterval);
    enableDownloadButtons(meeting_id);
  }
}, 5000);

// 3. Download artifacts when complete
const audioUrl = await downloadAndDecryptAudio(meeting_id, privateKey);
const transcript = await downloadAndDecryptTranscript(meeting_id, privateKey);
const summary = await downloadAndDecryptSummary(meeting_id, privateKey);

// 4. User deletes meeting
await deleteMeeting(meeting_id);
```
