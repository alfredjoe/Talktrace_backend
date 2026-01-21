import sys
import json
import os
import warnings
import torch
import whisperx
import re

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
        
        sys.stderr.write(f"[WhisperX] Transcribing...\n")
        audio = whisperx.load_audio(audio_path)
        sys.stderr.write(f"[WhisperX] Audio loaded. Sample count: {len(audio)}. Duration: {len(audio)/16000:.2f}s\n")
        
        result = model.transcribe(audio, batch_size=16)
        
        # 2. ALIGN (Needed for accurate word timestamps for diarization)
        # sys.stderr.write(f"[WhisperX] Aligning...\n")
        # model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
        # result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
        
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
        
        # 4.5 REGEX SPEAKER ID (User Request)
        # Scan first 60 seconds for "My name is <Name>"
        speaker_map = {}
        try:
             for seg in final_result["segments"]:
                if seg["start"] > 60: 
                    # Assuming segments are sorted; if not, just check start time
                    continue
                
                text = seg["text"]
                # Regex: Case insensitive "my name is " followed by name chars until punctuation or logical end
                # Captures: "Alfred", "Alfred Joe", "Alfred Joe Devasia"
                match = re.search(r"(?i)\bmy\s+name\s+is\s+([a-z\s]+?)(?=[.,!?]|$)", text)
                if match:
                    extracted_name = match.group(1).strip()
                    speaker_id = seg.get("speaker")
                    
                    # Valid name check (e.g. not empty, not too long)
                    if speaker_id and speaker_id not in speaker_map and 1 < len(extracted_name) < 50:
                        clean_name = extracted_name.title()
                        speaker_map[speaker_id] = clean_name
                        sys.stderr.write(f"[WhisperX] Auto-Identified Speaker: {speaker_id} -> '{clean_name}'\n")
        except Exception as e_regex:
            sys.stderr.write(f"[WhisperX] Warning: Regex check failed: {e_regex}\n")

        # 5. FORMAT OUTPUT
        # We need to match the format expected by server.js: { text: "...", segments: [...] }
        
        full_text = ""
        output_segments = []
        
        for seg in final_result["segments"]:
            text = seg["text"].strip()
            full_text += text + " "
            
            raw_speaker = seg.get("speaker", "Speaker")
            final_speaker = speaker_map.get(raw_speaker, raw_speaker) # Apply mapping
            
            output_segments.append({
                "start": seg["start"],
                "end": seg["end"],
                "text": text,
                "speaker": final_speaker
            })
            
        print(json.dumps({
            "text": full_text.strip(),
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
