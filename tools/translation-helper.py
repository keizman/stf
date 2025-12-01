#!/usr/bin/env python3
"""
Translation helper script for STF
Usage:
  python translation-helper.py list              # List all languages
  python translation-helper.py sample            # Show sample from each language file
  python translation-helper.py add KEY VALUE     # Add translation to all languages (English value)
  python translation-helper.py add-lang LANG KEY VALUE  # Add translation to specific language
"""

import os
import sys
import json
import glob

TRANSLATIONS_DIR = os.path.join(os.path.dirname(__file__), '../res/common/lang/translations')

def get_translation_files():
    """Get all translation JSON files"""
    pattern = os.path.join(TRANSLATIONS_DIR, 'stf.*.json')
    return sorted(glob.glob(pattern))

def get_lang_from_file(filepath):
    """Extract language code from filename"""
    basename = os.path.basename(filepath)
    # stf.zh_CN.json -> zh_CN
    return basename.replace('stf.', '').replace('.json', '')

def list_languages():
    """List all available languages"""
    files = get_translation_files()
    print("Available languages:")
    for f in files:
        lang = get_lang_from_file(f)
        print(f"  {lang}")
    return [get_lang_from_file(f) for f in files]

def show_sample():
    """Show first line sample from each translation file"""
    files = get_translation_files()
    print("Sample from each language file:")
    for f in files:
        lang = get_lang_from_file(f)
        try:
            with open(f, 'r', encoding='utf-8') as fp:
                data = json.load(fp)
                # Get first key-value pair
                if lang in data and data[lang]:
                    first_key = list(data[lang].keys())[0]
                    first_val = data[lang][first_key]
                    print(f"\n{lang}:")
                    print(f'  {{"{lang}":{{"{ first_key}":"{first_val}"}}}}')
        except Exception as e:
            print(f"  {lang}: Error - {e}")

def add_translation(key, value, lang=None):
    """Add translation to language file(s)"""
    files = get_translation_files()
    
    for f in files:
        file_lang = get_lang_from_file(f)
        
        # Skip if specific language requested and doesn't match
        if lang and file_lang != lang:
            continue
            
        try:
            with open(f, 'r', encoding='utf-8') as fp:
                data = json.load(fp)
            
            if file_lang not in data:
                data[file_lang] = {}
            
            data[file_lang][key] = value
            
            with open(f, 'w', encoding='utf-8') as fp:
                json.dump(data, fp, ensure_ascii=False, indent=2)
            
            print(f"Added to {file_lang}: {key} = {value}")
            
        except Exception as e:
            print(f"Error updating {file_lang}: {e}")

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == 'list':
        list_languages()
    elif cmd == 'sample':
        show_sample()
    elif cmd == 'add' and len(sys.argv) >= 4:
        key = sys.argv[2]
        value = sys.argv[3]
        add_translation(key, value)
    elif cmd == 'add-lang' and len(sys.argv) >= 5:
        lang = sys.argv[2]
        key = sys.argv[3]
        value = sys.argv[4]
        add_translation(key, value, lang)
    else:
        print(__doc__)
        sys.exit(1)

if __name__ == '__main__':
    main()

