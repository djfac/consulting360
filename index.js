const express = require("express");
const { twiml: { VoiceResponse } } = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: true }));

app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();
  // 👇 IMPORTANTE: solo respondemos con <Say>, nada de <Dial>
  vr.say({ language: "es-ES" }, "Hola. Tu servidor ya está conectado a Twilio. Prueba exitosa.");
  res.type("text/xml");
  res.send(vr.toString());
});

app.get("/", (_req, res) => res.send("✅ Servidor Render funcionando con Node.js"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Servidor en puerto", port));

