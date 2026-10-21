// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/**
 * Playing card audio, video and text-to-speech (desktop's av_player), using
 * media elements and the Web Speech API instead of mpv.
 */

import type { AVTag } from "@generated/anki/card_rendering_pb";

import { VIDEO_EXTENSIONS } from "./files";
import { mediaUrl } from "./media";

interface Playing {
    stop(): void;
    togglePause(): void;
    seek(seconds: number): void;
}

type DoneListener = () => void;

function extension(filename: string): string {
    return filename.split(".").pop()?.toLowerCase() ?? "";
}

function ttsLang(lang: string): string {
    return lang.replace("_", "-");
}

function chooseVoice(voices: string[], lang: string): SpeechSynthesisVoice | undefined {
    const available = speechSynthesis.getVoices();
    for (const wanted of voices) {
        const name = wanted.replace(/^[A-Za-z]+_/, "").toLowerCase();
        const voice = available.find((v) => v.name.toLowerCase() === wanted.toLowerCase())
            ?? available.find((v) => v.name.toLowerCase().includes(name));
        if (voice) {
            return voice;
        }
    }
    const tag = ttsLang(lang).toLowerCase();
    return available.find((v) => v.lang.toLowerCase() === tag)
        ?? available.find((v) => v.lang.toLowerCase().startsWith(tag.split("-")[0]));
}

let videoOverlay: HTMLDivElement | null = null;

function showVideo(video: HTMLVideoElement): () => void {
    videoOverlay?.remove();
    const overlay = document.createElement("div");
    overlay.className = "av-video-overlay";
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            video.pause();
            video.dispatchEvent(new Event("ended"));
        }
    });
    overlay.appendChild(video);
    document.body.appendChild(overlay);
    videoOverlay = overlay;
    return () => {
        overlay.remove();
        if (videoOverlay === overlay) {
            videoOverlay = null;
        }
    };
}

class AvPlayer {
    private queue: (() => Playing | null)[] = [];
    private current: Playing | null = null;
    private doneListeners = new Set<DoneListener>();

    /** Called whenever the queue finishes playing (av_player_did_end_playing). */
    onDidEndPlaying(listener: DoneListener): () => void {
        this.doneListeners.add(listener);
        return () => this.doneListeners.delete(listener);
    }

    get isPlaying(): boolean {
        return this.current !== null;
    }

    get queueIsEmpty(): boolean {
        return this.queue.length === 0 && this.current === null;
    }

    /** When new audio is played, whether what is playing stops (a collection setting). */
    interruptCurrentAudio = true;

    /** Replaces the queue with these tags, stopping what is playing if set to. */
    playTags(tags: AVTag[]): void {
        this.queue = [];
        if (this.interruptCurrentAudio) {
            this.stopAndClearQueue();
        }
        for (const tag of tags) {
            this.queue.push(() => this.start(tag));
        }
        this.playNext();
    }

    /** Plays one media file, interrupting what is playing. */
    playFile(filename: string): void {
        this.stopAndClearQueue();
        this.queue.push(() => this.startFile(filename));
        this.playNext();
    }

    /** Plays a URL (eg a recording). */
    playUrl(url: string): void {
        this.stopAndClearQueue();
        this.queue.push(() => this.startMedia(url, false));
        this.playNext();
    }

    stopAndClearQueue(): void {
        this.queue = [];
        const current = this.current;
        this.current = null;
        current?.stop();
    }

    togglePause(): void {
        this.current?.togglePause();
    }

    seekRelative(seconds: number): void {
        this.current?.seek(seconds);
    }

    private finished(playing: Playing): void {
        if (this.current !== playing) {
            return;
        }
        this.current = null;
        this.playNext();
    }

    private playNext(): void {
        while (!this.current && this.queue.length) {
            this.current = this.queue.shift()!();
        }
        if (!this.current) {
            for (const listener of [...this.doneListeners]) {
                listener();
            }
        }
    }

    private start(tag: AVTag): Playing | null {
        if (tag.value.case === "soundOrVideo") {
            return this.startFile(tag.value.value);
        }
        if (tag.value.case === "tts") {
            return this.startTts(tag.value.value.fieldText, tag.value.value.lang, tag.value.value.voices, tag.value.value.speed);
        }
        return null;
    }

    private startFile(filename: string): Playing | null {
        return this.startMedia(mediaUrl(filename), VIDEO_EXTENSIONS.includes(extension(filename)));
    }

    private startMedia(url: string, isVideo: boolean): Playing {
        const element = isVideo ? document.createElement("video") : new Audio();
        let hideVideo: (() => void) | null = null;
        if (element instanceof HTMLVideoElement) {
            element.controls = true;
            element.playsInline = true;
            hideVideo = showVideo(element);
        }
        const playing: Playing = {
            stop: () => {
                element.pause();
                element.removeAttribute("src");
                element.load();
                hideVideo?.();
            },
            togglePause: () => (element.paused ? void element.play() : element.pause()),
            seek: (seconds) => {
                element.currentTime = Math.max(0, element.currentTime + seconds);
            },
        };
        const done = () => {
            hideVideo?.();
            this.finished(playing);
        };
        element.addEventListener("ended", done);
        element.addEventListener("error", () => {
            console.warn("could not play", url);
            done();
        });
        element.src = url;
        element.play().catch((err) => {
            // autoplay blocked or unsupported format
            console.warn("playback failed", url, err);
            done();
        });
        return playing;
    }

    private startTts(text: string, lang: string, voices: string[], speed: number): Playing | null {
        if (!("speechSynthesis" in window)) {
            return null;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = ttsLang(lang);
        const voice = chooseVoice(voices, lang);
        if (voice) {
            utterance.voice = voice;
        }
        utterance.rate = speed || 1;
        const playing: Playing = {
            stop: () => speechSynthesis.cancel(),
            togglePause: () => (speechSynthesis.paused ? speechSynthesis.resume() : speechSynthesis.pause()),
            seek: () => {},
        };
        utterance.onend = () => this.finished(playing);
        utterance.onerror = () => this.finished(playing);
        speechSynthesis.speak(utterance);
        return playing;
    }
}

export const avPlayer = new AvPlayer();

// Recording
//////////////////////////////////////////////////////////////////////////////

export interface Recorder {
    stop(): Promise<{ blob: Blob; ext: string }>;
    cancel(): void;
    /** 0..1, for a level meter. */
    level(): number;
}

function recordingFormat(): { mimeType: string; ext: string } {
    for (const [mimeType, ext] of [
        ["audio/ogg;codecs=opus", "ogg"],
        ["audio/webm;codecs=opus", "webm"],
        ["audio/mp4", "m4a"],
    ]) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
            return { mimeType, ext };
        }
    }
    return { mimeType: "", ext: "webm" };
}

export async function startRecording(): Promise<Recorder> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const format = recordingFormat();
    const recorder = new MediaRecorder(stream, format.mimeType ? { mimeType: format.mimeType } : {});
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const release = () => {
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
    };
    recorder.start();
    return {
        stop: () =>
            new Promise((resolve) => {
                recorder.addEventListener("stop", () => {
                    release();
                    resolve({ blob: new Blob(chunks, { type: recorder.mimeType }), ext: format.ext });
                }, { once: true });
                recorder.stop();
            }),
        cancel: () => {
            if (recorder.state !== "inactive") {
                recorder.stop();
            }
            release();
        },
        level: () => {
            analyser.getByteTimeDomainData(samples);
            let peak = 0;
            for (const sample of samples) {
                peak = Math.max(peak, Math.abs(sample - 128));
            }
            return peak / 128;
        },
    };
}
