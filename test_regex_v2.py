import re
import unittest

def extract_speaker(text, speaker_id, speaker_map):
    # Matches implementation in diarize.py
    match = re.search(r"(?i)\bmy\s+name\s+is\s+([a-z\s]+?)(?:\s+and\s+my\s+id\s+is\s+(\w+))?(?=[.,!?]|$)", text)
    if match:
        extracted_name = match.group(1).strip()
        extracted_id = match.group(2) 

        # Valid name check 
        if speaker_id and 1 < len(extracted_name) < 50:
            clean_name = extracted_name.title()
            if extracted_id:
                clean_name = f"{clean_name} {extracted_id}"
            return clean_name
    return None

class TestSpeakerRegex(unittest.TestCase):
    def test_name_only(self):
        self.assertEqual(extract_speaker("My name is John Doe, hello.", "SPK_00", {}), "John Doe")

    def test_name_and_id(self):
        self.assertEqual(extract_speaker("My name is Jane and my id is 123.", "SPK_01", {}), "Jane 123")
        
    def test_name_punctuation(self):
        self.assertEqual(extract_speaker("Hello my name is Bob.", "SPK_02", {}), "Bob")

    def test_name_and_id_punctuation(self):
        self.assertEqual(extract_speaker("My name is Alice and my id is A01!", "SPK_03", {}), "Alice A01")

if __name__ == '__main__':
    unittest.main()
