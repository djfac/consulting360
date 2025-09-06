// index.js — Puente Twilio Media Streams <-> OpenAI Realtime (voz a voz)
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { twiml: { VoiceResponse } } = require("twilio");
const app = express();

app.use(express.urlencoded({ extended: true }));

// === 1) Webhook de voz (TwiML) ===
// Cambia say() por <Connect><Stream> para abrir stream bidireccional hacia nuestro WS.
app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();

  // Mensaje legal breve (opcional) y luego conectamos el stream
  // vr.say({ language: "es-ES" }, "Esta llamada puede ser grabada con su autorización.");
  const conn = vr.connect();
  // MUY IMPORTANTE: track="both_tracks" para audio de ida y vuelta
  conn.stream({ url: `wss://${req.headers.host}/wss/twilio`, track: "both_tracks" });

  res.type("text/xml").send(vr.toString());
});

// Salud
app.get("/", (_req, res) => res.send("✅ Servidor Render funcionando con Node.js"));

// === 2) Servidor HTTP + WebSocket para Twilio ===
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/wss/twilio" });

// --- Utilidades de audio (μ-law <-> PCM16 y resampling) ---
const MULAW_BIAS = 132;
function mulawDecodeByte(u) {
  u = ~u & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  // Fórmula clásica G.711
  let sample = ((mantissa | 0x10) << 3) << exponent;
  sample = (sample - MULAW_BIAS) * sign;
  // Clamp a int16
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}
function mulawDecode(base64) {
  const ulaw = Buffer.from(base64, "base64");
  const pcm = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) pcm[i] = mulawDecodeByte(ulaw[i]);
  return pcm; // 8k Hz PCM16
}
function mulawEncodeSample(sample) {
  let sign = (sample < 0) ? 0x80 : 0;
  sample = Math.abs(sample) + MULAW_BIAS;
  if (sample > 32767) sample = 32767;

  // Encuentra exponente
  let exponent = 7;
  for (let expMask = 0x4000; exponent > 0 && (sample & expMask) === 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const uVal = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return uVal;
}
function mulawEncode(int16) {
  const out = Buffer.allocUnsafe(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = mulawEncodeSample(int16[i]);
  return out;
}
function upsample8kTo16k(int16_8k) {
  // Interpolación lineal simple (suficiente para pruebas)
  const out = new Int16Array(int16_8k.length * 2);
  for (let i = 0; i < int16_8k.length - 1; i++) {
    const a = int16_8k[i], b = int16_8k[i + 1];
    out[2*i] = a;
    out[2*i + 1] = (a + b) >> 1;
  }
  out[out.length - 1] = int16_8k[int16_8k.length - 1];
  return out;
}
function downsample16kTo8k(int16_16k) {
  const out = new Int16Array(Math.floor(int16_16k.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) out[j] = int16_16k[i];
  return out;
}
function int16ToBase64PCM(int16) {
  const buf = Buffer.alloc(int16.length * 2);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], i * 2);
  return buf.toString("base64");
}
function base64PCMToInt16(b64) {
  const buf = Buffer.from(b64, "base64");
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

// --- Conexión con OpenAI Realtime vía WebSocket ---
const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"; // o gpt-realtime
const OPENAI_HEADERS = {
  "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
  "OpenAI-Beta": "realtime=v1"
};

wss.on("connection", async (twilioWS) => {
  console.log("📞 Twilio stream conectado");
  let streamSid = null;

  // 1) Abrimos WS con OpenAI
  const OpenAIWS = new (require("ws"))(OPENAI_WS_URL, { headers: OPENAI_HEADERS });

  // Buffer para agrupar audio entrante antes de "commit"
  let captureBuffers16k = [];
  let framesSinceLastCommit = 0;

  // Al abrir sesión con OpenAI, configuramos voz e instrucciones
  OpenAIWS.on("open", () => {
    console.log("🤖 Conectado a OpenAI Realtime");
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Instrucciones del agente (ajústalas a tu negocio)
        instructions:
          "Eres un asistente telefónico para Colombia. Saluda con cortesía, habla claro y breve. No des información sensible. Si el usuario pide hablar con humano, dilo y finaliza.",
        input_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        output_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        voice: "alloy"
      }
    };
    OpenAIWS.send(JSON.stringify(sessionUpdate));
  });

  // 2) Twilio -> OpenAI (audio entrante)
  twilioWS.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg);

      if (evt.event === "start") {
        streamSid = evt.start.streamSid;
        console.log("streamSid:", streamSid);
        return;
      }

      if (evt.event === "media" && evt.media && evt.media.payload) {
        // Twilio envía μ-law 8k → decodificamos y subimos a 16k PCM
        const pcm8k = mulawDecode(evt.media.payload);
        const pcm16k = upsample8kTo16k(pcm8k);
        captureBuffers16k.push(pcm16k);
        framesSinceLastCommit++;

        // Cada ~25 frames (≈500ms) mandamos a la IA
        if (framesSinceLastCommit >= 25 && OpenAIWS.readyState === OpenAIWS.OPEN) {
          const joined = concatInt16(captureBuffers16k);
          const b64 = int16ToBase64PCM(joined);
          OpenAIWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          OpenAIWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          OpenAIWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));

          captureBuffers16k = [];
          framesSinceLastCommit = 0;
        }
      }

      if (evt.event === "stop") {
        console.log("🔚 Twilio stream stop");
        twilioWS.close();
        OpenAIWS.close();
      }
    } catch (e) {
      console.error("Parse error Twilio msg:", e);
    }
  });

  twilioWS.on("close", () => {
    console.log("❎ Twilio WS cerrado");
    try { OpenAIWS.close(); } catch {}
  });

  // 3) OpenAI -> Twilio (audio de salida)
  // Recolectamos deltas de audio 16k PCM, bajamos a 8k, codificamos μ-law y enviamos en frames de 20ms (160 muestras a 8k)
  let pcmOutBuffer16k = new Int16Array(0);

  OpenAIWS.on("message", (data) => {
    try {
      const evt = JSON.parse(data);

      // Audio en partes
      if (evt.type === "response.output_audio.delta" && evt.delta) {
        const chunk16k = base64PCMToInt16(evt.delta);
        pcmOutBuffer16k = concatInt16([pcmOutBuffer16k, chunk16k]);

        // Si tenemos suficiente, mandamos a Twilio en paquetes de 20 ms @8k -> 160 muestras
        const pcmOut8k = downsample16kTo8k(pcmOutBuffer16k);
        const samplesPerFrame = 160; // 20ms @ 8k
        const totalFrames = Math.floor(pcmOut8k.length / samplesPerFrame);

        if (totalFrames > 0 && streamSid && twilioWS.readyState === twilioWS.OPEN) {
          for (let f = 0; f < totalFrames; f++) {
            const frame = pcmOut8k.subarray(f * samplesPerFrame, (f + 1) * samplesPerFrame);
            const ulaw = mulawEncode(frame);
            const b64 = ulaw.toString("base64");
            twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
          }
          // Conserva el residuo que no alcanzó a completar un frame
          const remain = pcmOut8k.length - totalFrames * samplesPerFrame;
          // Reconstruye buffer16k desde el residuo 8k (sube a 16k duplicando)
          const tail8k = pcmOut8k.subarray(pcmOut8k.length - remain);
          pcmOutBuffer16k = upsample8kTo16k(tail8k);
        }
      }

      // Fin de respuesta
      if (evt.type === "response.completed" || evt.type === "response.cancelled") {
        // opcional: marcar finalización
      }
    } catch (e) {
      // OpenAI también puede mandar binario (no JSON) en el futuro
    }
  });

  OpenAIWS.on("close", () => console.log("🤖 OpenAI WS cerrado"));
  OpenAIWS.on("error", (e) => console.error("OpenAI WS error:", e));
});

// Helper: concatenar varios Int16Array
function concatInt16(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Arrancar HTTP+WS
const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Servidor en puerto", port));

