import os
import logging
from concurrent.futures import ThreadPoolExecutor
import requests
from flask import Flask, request, jsonify, send_from_directory
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ.get("API_KEY")
BASE_URL = "https://api.sarvam.ai"

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("setu")

MAX_TEXT_CHARS = 1000
MAX_AUDIO_BYTES = 8 * 1024 * 1024  # 8 MB
HTTP_TIMEOUT = 45

app = Flask(__name__, static_folder="public", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_AUDIO_BYTES + 1024 * 64

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[],
    storage_uri="memory://",
)

LANG_CODES = {"en": "en-IN", "hi": "hi-IN", "kn": "kn-IN"}
ALL_LANGS = ["en", "hi", "kn"]


def auth_headers(extra=None):
    headers = {"api-subscription-key": API_KEY}
    if extra:
        headers.update(extra)
    return headers


def speech_to_text(file_bytes, filename, mimetype):
    files = {"file": (filename, file_bytes, mimetype)}
    data = {"model": "saaras:v3", "mode": "transcribe", "language_code": "unknown"}
    res = requests.post(f"{BASE_URL}/speech-to-text", headers=auth_headers(), files=files, data=data, timeout=HTTP_TIMEOUT)
    if not res.ok:
        raise RuntimeError(f"speech-to-text failed ({res.status_code}): {res.text}")
    body = res.json()
    detected_lang = (body.get("language_code") or "").split("-")[0]
    return body.get("transcript"), detected_lang


def translate_text(text, source_lang_code, target_lang_code):
    res = requests.post(
        f"{BASE_URL}/translate",
        headers=auth_headers({"Content-Type": "application/json"}),
        json={
            "input": text,
            "source_language_code": source_lang_code,
            "target_language_code": target_lang_code,
            "model": "mayura:v1",
        },
        timeout=HTTP_TIMEOUT,
    )
    if not res.ok:
        raise RuntimeError(f"translate failed ({res.status_code}): {res.text}")
    return res.json().get("translated_text")


def text_to_speech(text, target_lang_code):
    res = requests.post(
        f"{BASE_URL}/text-to-speech",
        headers=auth_headers({"Content-Type": "application/json"}),
        json={
            "text": text,
            "target_language_code": target_lang_code,
            "model": "bulbul:v3",
            "speaker": "shubh",
            "speech_sample_rate": 22050,
        },
        timeout=HTTP_TIMEOUT,
    )
    if not res.ok:
        raise RuntimeError(f"text-to-speech failed ({res.status_code}): {res.text}")
    return res.json()["audios"][0]


def targets_for(source_lang):
    if source_lang not in ALL_LANGS:
        return None
    return [lang for lang in ALL_LANGS if lang != source_lang]


def build_translations(source_text, source_lang):
    targets = targets_for(source_lang)
    if not targets:
        raise ValueError(f'Unsupported source language "{source_lang}"')

    source_lang_code = LANG_CODES[source_lang]

    def work(target):
        code = LANG_CODES[target]
        translated = translate_text(source_text, source_lang_code, code)
        return target, {"text": translated, "audioBase64": text_to_speech(translated, code)}

    with ThreadPoolExecutor(max_workers=len(targets)) as pool:
        return dict(pool.map(work, targets))


def friendly_error(err):
    """Map low-level failures to messages a user can act on."""
    msg = str(err)
    if isinstance(err, requests.Timeout):
        return "The language service took too long. Please try again.", 504
    if isinstance(err, requests.ConnectionError):
        return "Could not reach the language service. Check your connection.", 502
    if "(401" in msg or "(403" in msg:
        return "Server API key is invalid or missing. Contact the administrator.", 500
    if "(429" in msg:
        return "The language service is busy or out of credits. Try again shortly.", 429
    return "Something went wrong while translating. Please try again.", 500


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Permissions-Policy"] = "microphone=(self)"
    if request.path in ("/sw.js", "/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": "Recording is too long. Keep it under about a minute."}), 413


@app.errorhandler(429)
def rate_limited(_):
    return jsonify({"error": "Too many requests. Please wait a moment and try again."}), 429


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/sw.js")
def service_worker():
    return send_from_directory(app.static_folder, "sw.js", mimetype="application/javascript")


@app.route("/api/health")
def health():
    return jsonify({"ok": True})


@app.route("/api/translate-text", methods=["POST"])
@limiter.limit("12 per minute")
def translate_text_route():
    body = request.get_json(silent=True) or {}
    text = body.get("text")
    source_lang = body.get("sourceLang")
    if not isinstance(text, str) or not text.strip() or not source_lang:
        return jsonify({"error": "text and sourceLang are required"}), 400
    text = text.strip()
    if len(text) > MAX_TEXT_CHARS:
        return jsonify({"error": f"Text is too long (max {MAX_TEXT_CHARS} characters)."}), 400
    if source_lang not in ALL_LANGS:
        return jsonify({"error": "Unsupported language."}), 400
    try:
        translations = build_translations(text, source_lang)
        return jsonify({"source": {"lang": source_lang, "text": text}, "translations": translations})
    except Exception as err:
        log.exception("request failed")
        message, status = friendly_error(err)
        return jsonify({"error": message}), status


@app.route("/api/translate-audio", methods=["POST"])
@limiter.limit("12 per minute")
def translate_audio_route():
    if "audio" not in request.files:
        return jsonify({"error": "audio file is required"}), 400
    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()
    if len(audio_bytes) < 500:
        return jsonify({"error": "Recording was empty. Please try again."}), 400
    mimetype = (audio_file.mimetype or "audio/webm").split(";")[0]
    try:
        transcript, detected_lang = speech_to_text(
            audio_bytes, audio_file.filename or "audio.webm", mimetype
        )
        if not transcript:
            return jsonify({"error": "Could not transcribe audio. Please try again."}), 422
        if not targets_for(detected_lang):
            return jsonify({"error": "Sorry, only English, Hindi and Kannada are supported."}), 422

        translations = build_translations(transcript, detected_lang)
        return jsonify({"source": {"lang": detected_lang, "text": transcript}, "translations": translations})
    except Exception as err:
        log.exception("request failed")
        message, status = friendly_error(err)
        return jsonify({"error": message}), status


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    app.run(host="0.0.0.0", port=port, debug=False)
