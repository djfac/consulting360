// index.js — Puente Twilio Media Streams <-> OpenAI Realtime (voz a voz)
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { twiml: { VoiceResponse } } = require("twilio");
const app = express();

app.use(express.urlencoded({ extended: true }));

// 1) Webhook de voz: abrimos el stream hacia nuestro WS
app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();
  // (Opcional) aviso legal:
  // vr.say({ language: "es-ES" }, "Esta llamada puede ser grabada con su autorización.");
  const c = vr.connect();
  c.stream({ url: `wss://${req.headers.host}/wss/twilio`, track: "both_tracks" });
  res.type("text/xml").send(vr.toString());
});

// Salud
app.get("/", (_req,res)=>res.send("OK"));

// 2) HTTP + WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/wss/twilio" });

// ---------- μ-law <-> PCM16 + (re)muestreo simple para pruebas ----------
const MULAW_BIAS = 132;
function mulawDecodeByte(u){u=~u&255;const s=u&128?-1:1,e=u>>4&7,m=u&15;let x=((m|16)<<3)<<e;x=(x-MULAW_BIAS)*s;return Math.max(-32768,Math.min(32767,x))}
function mulawDecode(b64){const ul=Buffer.from(b64,"base64");const pcm=new Int16Array(ul.length);for(let i=0;i<ul.length;i++)pcm[i]=mulawDecodeByte(ul[i]);return pcm}
function mulawEncodeSample(s){let sign=s<0?128:0;s=Math.abs(s)+MULAW_BIAS;if(s>32767)s=32767;let e=7;for(let m=16384;e>0&&(s&m)===0;e--,m>>=1){}const man=(s>>>(e+3))&15;return ~((sign)|(e<<4)|man)&255}
function mulawEncode(i16){const out=Buffer.allocUnsafe(i16.length);for(let i=0;i<i16.length;i++)out[i]=mulawEncodeSample(i16[i]);return out}
function up8to16(i8){const out=new Int16Array(i8.length*2);for(let i=0;i<i8.length-1;i++){const a=i8[i],b=i8[i+1];out[2*i]=a;out[2*i+1]=(a+b)>>1}out[out.length-1]=i8[i8.length-1];return out}
function down16to8(i16){const out=new Int16Array(Math.floor(i16.length/2));for(let i=0,j=0;j<out.length;i+=2,j++)out[j]=i16[i];return out}
function i16ToB64(i16){const buf=Buffer.alloc(i16.length*2);for(let i=0;i<i16.length;i++)buf.writeInt16LE(i16[i],i*2);return buf.toString("base64")}
function b64ToI16(b64){const buf=Buffer.from(b64,"base64");const out=new Int16Array(buf.length/2);for(let i=0;i<out.length;i++)out[i]=buf.readInt16LE(i*2);return out}
function catI16(chs){let n=0;for(const c of chs)n+=c.length;const out=new Int16Array(n);let o=0;for(const c of chs){out.set(c,o);o+=c.length}return out}

// 3) Conexión con OpenAI Realtime (WS)
const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const OPENAI_HEADERS = { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" };

wss.on("connection", (twilioWS) => {
  console.log("📞 Twilio stream conectado");
  let streamSid = null;

  const OpenAIWS = new (require("ws"))(OPENAI_WS_URL, { headers: OPENAI_HEADERS });

  OpenAIWS.on("open", () => {
    console.log("🤖 Conectado a OpenAI Realtime");
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: process.env.AGENT_INSTRUCTIONS ||
          "Eres un asistente telefónico para Colombia. Saluda y ayuda en frases cortas. Si piden humano, dilo y finaliza.",
        input_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        output_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
        voice: process.env.AGENT_VOICE || "alloy"
      }
    };
    OpenAIWS.send(JSON.stringify(sessionUpdate));
  });

  // Twilio -> OpenAI
  let buf16 = []; let frames = 0;
  twilioWS.on("message", (msg) => {
    try{
      const e = JSON.parse(msg);
      if (e.event === "start"){ streamSid = e.start.streamSid; return; }
      if (e.event === "media" && e.media?.payload){
        const pcm8 = mulawDecode(e.media.payload);
        const pcm16 = up8to16(pcm8);
        buf16.push(pcm16); frames++;
        if (frames >= 25 && OpenAIWS.readyState === OpenAIWS.OPEN){
          const joined = catI16(buf16);
          OpenAIWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: i16ToB64(joined) }));
          OpenAIWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          OpenAIWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
          buf16 = []; frames = 0;
        }
      }
      if (e.event === "stop"){ try{ OpenAIWS.close(); }catch{} }
    }catch{}
  });
  twilioWS.on("close", ()=>{ try{ OpenAIWS.close(); }catch{} });

  // OpenAI -> Twilio
  let out16 = new Int16Array(0);
  OpenAIWS.on("message", (data) => {
    try{
      const e = JSON.parse(data);
      if (e.type === "response.output_audio.delta" && e.delta){
        const chunk16 = b64ToI16(e.delta);
        out16 = catI16([out16, chunk16]);

        const pcm8 = down16to8(out16);
        const SAMPLES = 160; // 20ms @8k
        const frames = Math.floor(pcm8.length / SAMPLES);
        if (frames > 0 && streamSid && twilioWS.readyState === twilioWS.OPEN){
          for (let f=0; f<frames; f++){
            const frame = pcm8.subarray(f*SAMPLES, (f+1)*SAMPLES);
            const ulaw = mulawEncode(frame);
            twilioWS.send(JSON.stringify({ event:"media", streamSid, media:{ payload: ulaw.toString("base64") } }));
          }
          const remain = pcm8.length - frames*SAMPLES;
          const tail8 = pcm8.subarray(pcm8.length - remain);
          // reconstruye buffer 16k a partir del residuo 8k
          const up = new Int16Array(tail8.length*2);
          for (let i=0;i<tail8.length-1;i++){ up[2*i]=tail8[i]; up[2*i+1]=(tail8[i]+tail8[i+1])>>1; }
          if (tail8.length) up[up.length-1]=tail8[tail8.length-1];
          out16 = up;
        }
      }
    }catch{}
  });
  OpenAIWS.on("close", ()=>console.log("🤖 OpenAI WS cerrado"));
  OpenAIWS.on("error", (e)=>console.error("OpenAI WS error:", e));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Servidor en puerto", port));
