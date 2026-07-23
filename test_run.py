import subprocess
import json
import os
import sys

# Set important environment variables for testing
os.environ["MIN_SPEAKERS"] = "2"
os.environ["MAX_SPEAKERS"] = "2"
os.environ["WHISPER_MODEL"] = "base"

def test_diarize(audio_file_path):
    print(f"Testing diarize.py with: {audio_file_path}")
    print("Environment Variables:")
    print(f"  MIN_SPEAKERS = {os.environ.get('MIN_SPEAKERS')}")
    print(f"  MAX_SPEAKERS = {os.environ.get('MAX_SPEAKERS')}")
    print(f"  WHISPER_MODEL = {os.environ.get('WHISPER_MODEL')}")
    print("-" * 40)

    try:
        # Run the diarize script
        process = subprocess.run(
            ["python", "diarize.py", audio_file_path],
            capture_output=True,
            text=True,
            check=True
        )

        # Print all standard error output (useful logs from WhisperX)
        print("--- STDERR (Logs) ---")
        print(process.stderr)

        # Print standard output (The final JSON result)
        print("--- STDOUT (Result) ---")
        try:
            result_json = json.loads(process.stdout)
            # Pretty print the JSON
            print(json.dumps(result_json, indent=2))
        except json.JSONDecodeError:
            print("Failed to decode JSON. Raw stdout:")
            print(process.stdout)

    except subprocess.CalledProcessError as e:
        print(f"Process failed with return code {e.returncode}")
        print("--- STDERR ---")
        print(e.stderr)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_run.py <path_to_audio_file>")
        sys.exit(1)
        
    audio_path = sys.argv[1]
    test_diarize(audio_path)
