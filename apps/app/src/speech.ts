/**
 * Dictation, from the browser's own recognizer. Nothing is installed and no
 * audio leaves the engine the platform already runs: WebKit and Chromium expose
 * it as `SpeechRecognition`, and where they do not the composer shows no
 * microphone at all. The types are declared here because the DOM lib does not
 * carry them.
 */

interface SpeechRecognitionAlternative {
  readonly transcript: string;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternative | undefined;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResult | undefined;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognition;

interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

function recognizer(): SpeechRecognitionConstructor | undefined {
  const host = globalThis as unknown as SpeechWindow;
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

export function dictationSupported(): boolean {
  return recognizer() !== undefined;
}

export interface Dictation {
  start(): void;
  stop(): void;
}

export interface DictationHandlers {
  /** Everything heard since `start`, final parts first and the interim tail last. */
  onHeard: (transcript: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

const MESSAGES: Record<string, string> = {
  "not-allowed": "Dictation needs permission to use the microphone.",
  "service-not-allowed": "Dictation needs permission to use the microphone.",
  "audio-capture": "No microphone was found.",
  network: "The dictation service could not be reached.",
};

/** `undefined` where the browser has no recognizer, so the button can stay away. */
export function createDictation(handlers: DictationHandlers): Dictation | undefined {
  const Recognition = recognizer();
  if (Recognition === undefined) return undefined;
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language;

  recognition.onresult = (event) => {
    let heard = "";
    for (let index = 0; index < event.results.length; index += 1) {
      heard += event.results[index]?.[0]?.transcript ?? "";
    }
    handlers.onHeard(heard);
  };
  recognition.onerror = (event) => {
    // A silent pause is not a failure; the recognizer simply heard nothing.
    if (event.error === "no-speech" || event.error === "aborted") return;
    handlers.onError(MESSAGES[event.error] ?? `Dictation stopped: ${event.error}.`);
  };
  recognition.onend = handlers.onEnd;

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
  };
}
