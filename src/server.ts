import "dotenv/config";
process.env.TZ = "America/Bogota";
import express from "express";
import cors from "cors";
import productos from "./routes/productos";
import ventas from "./routes/ventas";
import borradores from "./routes/borradores";
import cajeros from "./routes/cajeros";
import clientes from "./routes/clientes";
import proveedores from "./routes/proveedores";
import reportes from "./routes/reportes";
import empresa from "./routes/empresa";
import backup from "./routes/backup";
import compras from "./routes/compras";
import dashboard from "./routes/dashboard";
import pagos from "./routes/pagos";
import ai from "./routes/ai";
import auth from "./routes/auth";
import separados from "./routes/separados";
import pagosSaaS from "./routes/pagosSaaS";
import kardex from "./routes/kardex";
import whatsapp from "./routes/whatsapp";
import dian from "./routes/dian";
import facturacionElectronica from "./routes/facturacionElectronica";
import caja from "./routes/caja";
import cartera from "./routes/cartera";
import documentosSoporte from "./routes/documentosSoporte";
import puntos from "./routes/puntos";
import sorteo from "./routes/sorteo";

import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Inyectar IO en el request para las rutas
app.use((req: any, _res, next) => {
  req.io = io;
  next();
});

io.on("connection", (socket) => {
  console.log(`[SOCKET]: Nuevo cliente conectado - ID: ${socket.id}`);

  // Unirse a una sala por empresa para no mezclar datos si hubiera múltiples empresas
  socket.on("join_empresa", (empresaId) => {
    socket.join(`empresa_${empresaId}`);
    console.log(`[SOCKET]: Cliente ${socket.id} unido a sala empresa_${empresaId}`);
  });

  socket.on("disconnect", () => {
    console.log(`[SOCKET]: Cliente desconectado - ID: ${socket.id}`);
  });
});

app.use("/productos", productos);
app.use("/ventas", ventas);
app.use("/borradores", borradores);
app.use("/cajeros", cajeros);
app.use("/clientes", clientes);
app.use("/proveedores", proveedores);
app.use("/reportes", reportes);
app.use("/empresa", empresa);
app.use("/backup", backup);
app.use("/compras", compras);
app.use("/dashboard", dashboard);
app.use("/pagos", pagos);
app.use("/ai", ai);
app.use("/auth", auth);
app.use("/separados", separados);
app.use("/suscripciones", pagosSaaS);
app.use("/kardex", kardex);
app.use("/whatsapp", whatsapp);
app.use("/dian", dian);
app.use("/facturacion-electronica", facturacionElectronica);
app.use("/caja", caja);
app.use("/cartera", cartera);
app.use("/documentos-soporte", documentosSoporte);
app.use("/puntos", puntos);
app.use("/sorteo", sorteo);

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT} con Socket.io habilitado`);
});
