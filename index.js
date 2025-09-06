// index.js — Puente Twilio Media Streams <-> OpenAI Realtime (voz a voz)
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { twiml: { VoiceResponse } } = require("twilio");
const app = express();

app.use(express.urlencoded({ extended: true }));

// === 1) Webhook de voz (TwiML) ===
app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();

  // (Opcional) aviso legal corto:
  // vr.say({ language: "es-ES" }, "Esta llamada puede ser grabada con su autorización.");

  const conn = vr.connect();
  // Abrimos stream bidireccional hacia nuestro WS
  conn.stream({ url: `wss://${req.headers.host}/wss/twilio`, track: "both_tracks" });

  res.type("text/xml").send(vr.toString());
});

// Salud
app.get("/", (_req, res) => res.send("✅ Servidor Render funcionando con Node.js"));

// === 2) Servidor HTTP + WebSocket para Twilio ===
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/wss/twilio" });

// ----- Utilidades audio μ-law <-> PCM16 + (re)muestreo simple -----
const MULAW_BIAS = 132;
function mulawDecodeByte(u){u=~u&255;const s=u&128?-1:1,e=u>>4&7,m=u&15;let x=((m|16)<<3)<<e;x=(x-MULAW_BIAS)*s;return Math.max(-32768,Math.min(32767,x))}
function mulawDecode(b64){const ulaw=Buffer.from(b64,"base64");const pcm=new Int16Array(ulaw.length);for(let i=0;i<ulaw.length;i++)pcm[i]=mulawDecodeByte(ulaw[i]);return pcm}
function mulawEncodeSample(sample){let sign=sample<0?128:0;sample=Math.abs(sample)+MULAW_BIAS;if(sample>32767)sample=32767;let exp=7;for(let m=16384;exp>0&&(sample&m)===0;exp--,m>>=1){}const man=(sample>>>(exp+3))&15;return ~((sign)|(exp<<4)|man)&255}
function mulawEncode(int16){const out=Buffer.allocUnsafe(int16.length);for(let i=0;i<int16.length;i++)out[i]=mulawEncodeSample(int16[i]);return out}
function upsample8kTo16k(in8){const out=new Int16Array(in8.length*2);for(let i=0;i<in8.length-1;i++){const a=in8[i],b=in8[i+1];out[2*i]=a;out[2*i+1]=(a+b)>>1}out[out.length-1]=in8[in8.length-1];return out}
function downsample16kTo8k(in16){const out=new Int16Array(Math.floor(in16.length/2));for(let i=0,j=0;j<out.length;i+=2,j++)out[j]=in16[i];return out}
function int16ToBase64PCM(int16){const buf=Buffer.alloc(int16.length*2);for(let i=0;i<int16.length;i++)buf.writeInt16LE(int16[i],i*2);return buf.toString("base64")}
function base64PCMToInt16(b64){const buf=Buffer.from(b64,"base64");const out=new Int16Array(buf.length/2);for(let i=0;i<out.length;i++)out[i]=buf.readInt16LE(i*2);return out}
function concatInt16(chunks){let total=0;for(const c of chunks)total+=c.length;const out=new Int16Array(total);let o=0;for(const c of chunks){out.set(c,o);o+=c.length}return out}

// === 3) Conexión con OpenAI Realtime vía WebSocket ===
const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const OPENAI_HEADERS = {
  "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
  "OpenAI-Beta": "realtime=v1"
};

wss.on("connection", async (twilioWS) => {
  console.log("📞 Twilio stream conectado");
  let streamSid = null;

  // WS con OpenAI
  const OpenAIWS = new (require("ws"))(OPENAI_WS_URL, { headers: OPENAI_HEADERS });

  // Configurar la sesión (voz + instrucciones)
  OpenAIWS.on("open", () => {
    console.log("🤖 Conectado a OpenAI Realtime");
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: process.env.AGENT_INSTRUCTIONS ||
          "Eres un asistente telefónico para Colombia. Saluda con cortesía y ve al punto. Si piden humano, dilo y finaliza.",
        input_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        output_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        voice: process.env.AGENT_VOICE || "alloy"
      }
    };
    OpenAIWS.send(JSON.stringify(sessionUpdate));
  });

  // Twilio -> OpenAI (subimos audio cada ~0.5 s)
  let capture16k = [];
  let frames = 0;

  twilioWS.on("message", (msg) => {
    try {
      const evt = JSON.parse(msg);

      if (evt.event === "start") {
        streamSid = evt.start.streamSid;
        return;
      }

      if (evt.event === "media" && evt.media?.payload) {
        const pcm8 = mulawDecode(evt.media.payload);
        const pcm16 = upsample8kTo16k(pcm8);
        capture16k.push(pcm16);
        frames++;

        if (frames >= 25 && OpenAIWS.readyState === OpenAIWS.OPEN) {
          const joined = concatInt16(capture16k);
          OpenAIWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: int16ToBase64PCM(joined) }));
          OpenAIWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          OpenAIWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
          capture16k = [];
          frames = 0;
        }
      }

      if (evt.event === "stop") {
        twilioWS.close();
        try { OpenAIWS.close(); } catch {}
      }
    } catch (e) { /* ignora */ }
  });

  twilioWS.on("close", () => { try { OpenAIWS.close(); } catch {} });

  // OpenAI -> Twilio (mandamos audio en frames μ-law 8k de 20 ms)
  let outBuf16 = new Int16Array(0);

  OpenAIWS.on("message", (data) => {
    try {
      const evt = JSON.parse(data);

      if (evt.type === "response.output_audio.delta" && evt.delta) {
        const chunk16 = base64PCMToInt16(evt.delta);
        outBuf16 = concatInt16([outBuf16, chunk16]);

        const pcm8 = downsample16kTo8k(outBuf16);
        const samplesPerFrame = 160; // 20 ms @ 8k
        const nFrames = Math.floor(pcm8.length / samplesPerFrame);

        if (nFrames > 0 && streamSid && twilioWS.readyState === twilioWS.OPEN) {
          for (let f = 0; f < nFrames; f++) {
            const frame = pcm8.subarray(f * samplesPerFrame, (f + 1) * samplesPerFrame);
            const ulaw = mulawEncode(frame);
            twilioWS.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: ulaw.toString("base64") }
            }));
          }
          const remain = pcm8.length - nFrames * samplesPerFrame;
          const tail8 = pcm8.subarray(pcm8.length - remain);
          outBuf16 = upsample8kTo16k(tail8);
        }
      }
    } catch { /* ignora */ }
  });

  OpenAIWS.on("close", () => console.log("🤖 OpenAI WS cerrado"));
  OpenAIWS.on("error", (e) => console.error("OpenAI WS error:", e));
});

// Arrancar
const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Servidor en puerto", port));
