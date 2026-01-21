import os
import sys

# 1. READ .ENV MANUALLY (To ensure we use the exact token visible to the file system)
env_token = None
try:
    with open(".env", "r") as f:
        for line in f:
            if line.strip().startswith("HF_TOKEN="):
                env_token = line.split("=", 1)[1].strip()
                # Remove quotes if present
                if env_token.startswith('"') and env_token.endswith('"'):
                    env_token = env_token[1:-1]
except Exception as e:
    print(f"Error reading .env: {e}")

if not env_token:
    print("❌ ERROR: Could not find HF_TOKEN in .env")
    sys.exit(1)

print(f"Token loaded from .env: {env_token[:4]}...{env_token[-4:]}")

# 2. LOGIN
try:
    from huggingface_hub import login, hf_hub_download
    from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError, LocalTokenNotFoundError
    
    print("Attempting login...")
    login(token=env_token)
    print("Login successful (locally).")

    # 3. CHECK MODELS
    models = [
        "pyannote/segmentation-3.0",
        "pyannote/speaker-diarization-community-1"
    ]

    print("\n--- CHECKING PERMISSIONS ---")
    all_good = True
    for model in models:
        sys.stdout.write(f"Testing access to {model}... ")
        try:
            # Try to download the config file (requires auth for gated repos)
            path = hf_hub_download(repo_id=model, filename="config.yaml") # uses logged-in token
            print("✅ GRANTED")
            print("❌ DENIED (Gated)")
            print(f"   -> You must accept the license at: https://huggingface.co/pyannote/speaker-diarization-community-1")
            all_good = False
        except RepositoryNotFoundError:
            print("❌ NOT FOUND (Check spelling)")
            all_good = False
        except Exception as e:
            print(f"❌ ERROR: {str(e)}")
            if "401" in str(e):
                print("   -> Token is invalid or expired.")
            all_good = False
            
    if all_good:
        msg = "\n✅ READY! The system should work."
        print(msg)
        with open("verify_result.txt", "w", encoding="utf-8") as f: f.write(msg)
    else:
        msg = "\n❌ BLOCKERS FOUND. Please fix the above issues."
        print(msg)
        with open("verify_result.txt", "w", encoding="utf-8") as f: f.write(msg)

except ImportError:
    print("Error: huggingface_hub library not installed. Run `pip install huggingface_hub`")
