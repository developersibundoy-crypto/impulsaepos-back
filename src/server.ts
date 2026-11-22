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
import jwt from "jsonwebtoken";
import tiendaPiloto from "./routes/tiendaPiloto";
import tiendaAdmin from "./routes/tiendaAdmin";
import tiendaPublica from "./routes/tiendaPublica";
import { iniciarWorkerReservas } from "./services/tiendaReservasWorker";

const app = express();
const httpServer = createServer(app);
// CORS_ORIGINS (lista separada por comas) restringe los orígenes del navegador. Sin definir, se mantiene
// "*" para no romper despliegues existentes: la autenticación del socket la da el JWT, no el origen.
const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins.length ? corsOrigins : "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});
app.set("io", io);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Inyectar IO en el request para las rutas
app.use((req: any, _res, next) => {
  req.io = io;
  next();
});

// Autenticación del handshake: sin un JWT válido no se establece la conexión.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || !token || !process.env.JWT_SECRET) {
    return next(new Error("No autorizado"));
  }
  jwt.verify(token, process.env.JWT_SECRET, (err: any, decoded: any) => {
    if (err || !decoded) return next(new Error("No autorizado"));
    const empresaId = Number(decoded.empresa_id);
    if (!Number.isSafeInteger(empresaId) || empresaId < 1) return next(new Error("No autorizado"));
    socket.data.empresaId = empresaId;
    socket.data.expiraEn = typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
    next();
  });
});

io.on("connection", (socket) => {
  const empresaId: number = socket.data.empresaId;
  // La sala sale de la identidad verificada, nunca de lo que envíe el cliente.
  socket.join(`empresa_${empresaId}`);
  console.log(`[SOCKET]: Cliente ${socket.id} autenticado en sala empresa_${empresaId}`);

  // Cerrar la conexión cuando el token expira, para no dejar sesiones vencidas con acceso a eventos.
  let temporizador: NodeJS.Timeout | null = null;
  if (socket.data.expiraEn) {
    const ms = Math.max(0, socket.data.expiraEn - Date.now());
    temporizador = setTimeout(() => socket.disconnect(true), Math.min(ms, 2 ** 31 - 1));
  }

  // Compatibilidad con clientes anteriores: solo se acepta la empresa del propio token.
  socket.on("join_empresa", (id) => {
    if (Number(id) !== empresaId) {
      console.warn(`[SOCKET]: Cliente ${socket.id} intentó unirse a una sala ajena (empresa ${String(id).slice(0, 20)}).`);
    }
  });

  socket.on("disconnect", () => {
    if (temporizador) clearTimeout(temporizador);
    console.log(`[SOCKET]: Cliente desconectado - ID: ${socket.id}`);
  });
});

app.use("/productos", productos);
app.use("/tienda-piloto", tiendaPiloto);
app.use("/tienda-admin", tiendaAdmin);
app.use("/tienda-publica", tiendaPublica);
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
  iniciarWorkerReservas(io);
});
