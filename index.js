const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("✅ Servidor Render funcionando con Node.js");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Servidor corriendo en puerto " + port);
});
