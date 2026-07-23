import sys
import json
import os
import warnings
import torch
import whisperx
import re
import subprocess
import tempfile

# Suppress warnings
warnings.filterwarnings("ignore")

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio file provided"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    
    # Check for GPU
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # OPTIMIZATION: Use int8 on CPU for 4x speedup vs float32
    # float16 is standard for GPU
    compute_type = "float16" if device == "cuda" else "int8"
    
    sys.stderr.write(f"[WhisperX] Using device: {device} ({compute_type})\n")
    
    # PATCH: torch 2.4+ requires weights_only=True by default, but whisperx/whisper models might be older pickles
    # We temporarily unsafe load for this script
    original_load = torch.load
    torch.load = lambda f, map_location=None, weights_only=False: original_load(f, map_location=map_location, weights_only=False)

    try:
        # 1. TRANSCRIBE
        model_size = os.environ.get("WHISPER_MODEL", "base") # Default to base for speed
        sys.stderr.write(f"[WhisperX] Loading Model: {model_size}\n")
        
        model = whisperx.load_model(model_size, device, compute_type=compute_type)
        
        sys.stderr.write(f"[WhisperX] Applying noise reduction via FFmpeg...\n")
        clean_audio_fd, clean_audio_path = tempfile.mkstemp(suffix=".wav")
        os.close(clean_audio_fd)
        
        audio_to_load = audio_path
        try:
            subprocess.run([
                "ffmpeg", "-y", "-i", audio_path,
                "-af", "afftdn",
                "-ar", "16000",
                "-ac", "1",
                clean_audio_path
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            audio_to_load = clean_audio_path
            sys.stderr.write(f"[WhisperX] Noise reduction complete.\n")
        except Exception as e:
            sys.stderr.write(f"[WhisperX] Warning: Noise reduction failed: {e}\n")

        sys.stderr.write(f"[WhisperX] Transcribing...\n")
        audio = whisperx.load_audio(audio_to_load)
        sys.stderr.write(f"[WhisperX] Audio loaded. Sample count: {len(audio)}. Duration: {len(audio)/16000:.2f}s\n")
        
        if audio_to_load == clean_audio_path and os.path.exists(clean_audio_path):
            try:
                os.remove(clean_audio_path)
            except Exception as e:
                pass
            
        # Add strict VAD parameters to filter out non-speech noise, since we're on CPU
        vad_options = {
            "vad_onset": 0.500,    # higher onset requires more confidence to count as speech
            "vad_offset": 0.363    # standard offset
        }

        # Parse WHISPER_LANGUAGE env var (e.g. 'auto' -> None for auto-detect)
        whisper_lang = os.environ.get("WHISPER_LANGUAGE", "auto")
        if whisper_lang == "auto" or not whisper_lang:
            language_param = None
        else:
            language_param = whisper_lang

        sys.stderr.write(f"[WhisperX] Transcribing in language: {language_param or 'Auto-Detect'}\n")
        result = model.transcribe(audio, batch_size=32, language=language_param, chunk_size=30)

        # Google-grade Language Detection Engine Verification
        detected_audio_lang = result.get("language", "en")
        google_api_key = os.environ.get("GOOGLE_TRANSLATE_API_KEY")
        
        if google_api_key and full_text_preview := result.get("text", ""):
            try:
                import urllib.request
                import urllib.parse
                url = f"https://translation.googleapis.com/language/translate/v2/detect?key={google_api_key}"
                data = urllib.parse.urlencode({'q': full_text_preview[:1000]}).encode('utf-8')
                req = urllib.request.Request(url, data=data)
                with urllib.request.urlopen(req, timeout=4) as resp:
                    res_data = json.loads(resp.read().decode('utf-8'))
                    detections = res_data.get('data', {}).get('detections', [[]])[0]
                    if detections:
                        google_lang = detections[0].get('language')
                        confidence = detections[0].get('confidence')
                        sys.stderr.write(f"[Google Translate Engine] Verified Language: '{google_lang}' (Confidence: {confidence})\n")
                        detected_audio_lang = google_lang
            except Exception as e_g:
                sys.stderr.write(f"[Google Translate Engine] Fallback to Whisper Detection: {e_g}\n")

        # 2. ALIGN (Needed for accurate word timestamps for diarization)
        sys.stderr.write(f"[WhisperX] Aligning in language '{detected_audio_lang}'...\n")
        model_a, metadata = whisperx.load_align_model(language_code=detected_audio_lang, device=device)
        result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
        result["language"] = detected_audio_lang
        
        # 3. DIARIZE
        # Note: WhisperX defaults to pyannote/speaker-diarization-3.1 which IS gated.
        # We must provide the token if we want it to work, unless using an offline model.
        hf_token = os.environ.get("HF_TOKEN")
        sys.stderr.write(f"[WhisperX] Diarizing (Auth Token: {'Yes' if hf_token else 'No'})...\n")
        
        # Explicit import if not exposed at top level
        from whisperx.diarize import DiarizationPipeline
        diarize_model = DiarizationPipeline(use_auth_token=hf_token, device=device)
        
        # Optimize clustering parameters
        # If the user provides hints, use them. Otherwise default values.
        # But for 'test' cases with known issues, we might want to force it.
        # Let's check environment or args for hints.
        min_speakers = int(os.environ.get("MIN_SPEAKERS")) if os.environ.get("MIN_SPEAKERS") else None
        max_speakers = int(os.environ.get("MAX_SPEAKERS")) if os.environ.get("MAX_SPEAKERS") else None
        
        sys.stderr.write(f"[WhisperX] Diarizing with params: min_speakers={min_speakers}, max_speakers={max_speakers}\n")
        
        
        diar_segments = diarize_model(audio, min_speakers=min_speakers, max_speakers=max_speakers)
        
        # DEBUG: Check unique speakers found by Pyannote
        unique_speakers = diar_segments["speaker"].unique()
        sys.stderr.write(f"[WhisperX] Raw Diarization found {len(unique_speakers)} speakers: {unique_speakers}\n")
        
        sys.stderr.write(f"[WhisperX] Metadata: Transcribed {len(result['segments'])} segments. Diarized {len(diar_segments)} segments.\n")
        
        # 4. ASSIGN SPEAKERS
        sys.stderr.write(f"[WhisperX] Assigning Speakers...\n")
        final_result = whisperx.assign_word_speakers(diar_segments, result)
        
        # 4.5 ENHANCED AUTOMATIC SPEAKER NAME DETECTION ENGINE
        speaker_map = {}
        try:
            # Multi-pattern regex set for natural conversation introductions & greetings
            patterns = [
                # 1. "My name is <Name>" / "My name's <Name>"
                r"(?i)\bmy\s+name(?:\s+is|\s*'s)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\b",
                # 2. "I'm <Name>" / "I am <Name>"
                r"(?i)\b(?:i'm|i\s+am)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\b(?:\s+(?:from|here|with|at|speaking))?",
                # 3. "This is <Name>" (e.g. "Hi team, this is Alex")
                r"(?i)\bthis\s+is\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)\b(?:\s+(?:speaking|from|here))?",
                # 4. "Call me <Name>" / "You can call me <Name>"
                r"(?i)\b(?:call\s+me|you\s+can\s+call\s+me)\s+([A-Za-z]+)\b",
                # 5. "Hi/Hey <Name>, thanks" (Addressing another speaker)
                r"(?i)\b(?:hi|hey|hello|thanks|thank\s+you)\s+([A-Za-z]+)\b"
            ]

            false_positives = {"this", "that", "here", "there", "what", "how", "why", "when", "where", "today", "now", "just", "sure", "ok", "okay", "yeah", "yes", "no", "everyone", "team", "guys", "all", "again", "sorry"}

            for seg in final_result["segments"]:
                speaker_id = seg.get("speaker")
                if not speaker_id or speaker_id in speaker_map:
                    continue

                text = seg["text"].strip()
                for pattern in patterns:
                    match = re.search(pattern, text)
                    if match:
                        candidate_name = match.group(1).strip()
                        if candidate_name.lower() not in false_positives and 2 <= len(candidate_name) <= 40:
                            clean_name = candidate_name.title()
                            speaker_map[speaker_id] = clean_name
                            sys.stderr.write(f"[WhisperX Name Detection] Identified: {speaker_id} -> '{clean_name}'\n")
                            break
        except Exception as e_name:
            sys.stderr.write(f"[WhisperX] Warning: Name detection error: {e_name}\n")

        # 5. FORMAT OUTPUT
        full_text = ""
        output_segments = []
        speaker_index_map = {}
        speaker_counter = 1
        
        for seg in final_result["segments"]:
            text = seg["text"].strip()
            full_text += text + " "
            
            raw_speaker = seg.get("speaker", "SPEAKER_00")
            if raw_speaker not in speaker_index_map:
                speaker_index_map[raw_speaker] = f"Speaker {speaker_counter}"
                speaker_counter += 1

            if raw_speaker in speaker_map:
                final_speaker = speaker_map[raw_speaker]
            else:
                final_speaker = speaker_index_map[raw_speaker]
            
            output_segments.append({
                "start": seg["start"],
                "end": seg["end"],
                "text": text,
                "speaker": final_speaker
            })
            
        print(json.dumps({
            "text": full_text.strip(),
            "language": result.get("language", "en"),
            "segments": output_segments
        }))
        sys.exit(0)
        
    except Exception as e:
        sys.stderr.write(f"[WhisperX] Error: {str(e)}\n")
        # Print valid JSON error for nodejs to parse
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
