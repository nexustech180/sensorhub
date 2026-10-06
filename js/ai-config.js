'use strict';
/*
 * Google Gemini API key for the optional AI helper (free from aistudio.google.com → Get API key).
 *
 * Keep this EMPTY in the repository. The Android build (.github/workflows/build-apk.yml)
 * fills it in from the GitHub repository secret GEMINI_API_KEY, so the key is never
 * published in the code. For testing on your own computer you may paste a key here,
 * but don't commit it.
 *
 * The key ends up inside the installed apps, where it can be extracted. Use a free-tier
 * key in a Google Cloud project with NO billing enabled, restricted to the
 * "Generative Language API": then the worst case is someone using up the free quota.
 */
const GEMINI_API_KEY = 'AQ.Ab8RN6LDFz54_oShb9_oJTd0FacI9YGOrfHVbEzEAOMUjrEZfQ;'
