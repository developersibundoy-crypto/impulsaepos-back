import express from "express";
import pool from "../conection";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const router = express.Router();
// Esta vista previa lee la copia del piloto, no el inventario publicable.
router.use((req, res, next) => {
  if (process.env.NODE_ENV === "production" || process.env.DB_HOST !== "127.0.0.1" ||
      process.env.DB_PORT !== "3307" || process.env.DB_NAME !== "impulsaepos_dev" ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "") ||
      !["localhost", "127.0.0.1", "[::1]"].includes(req.hostname) ||
      (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):3000$/.test(req.headers.origin))) {
    res.sendStatus(404); return;
  }
  res.set("Cache-Control","no-store");
  next();
});
router.get("/catalogo", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0,100);
  const where = `WHERE (LOCATE(?, nombre)>0 OR LOCATE(?, referencia)>0)${req.query.stock === "1" ? " AND cantidad>0" : ""}`;
  try {
    const db = pool.promise();
    const [result]: any = await db.execute(`SELECT COUNT(*) n FROM piloto_catalogo_a ${where}`, [q,q]);
    const total = Number(result[0].n);
    const paginas = Math.max(1, Math.ceil(total / 24));
    const pagina = Math.max(1, Math.min(paginas, Math.trunc(Number(req.query.p)) || 1));
    const [productos] = await db.query(`SELECT id,nombre,referencia,categoria,precio_venta,cantidad,cantidad>0 disponible
      FROM piloto_catalogo_a ${where} ORDER BY nombre,id LIMIT 24 OFFSET ?`, [q,q,(pagina-1)*24]);
    res.set("Cache-Control","no-store").json({productos,total,pagina,paginas});
  } catch {
    res.status(503).json({error:"No se pudo consultar el catálogo piloto local."});
  }
});
const db=pool.promise();
const refValida=(v:unknown)=>typeof v==="string" && /^[a-f0-9]{48}$/.test(v);
type Item={id:number; cantidad:number};
async function cotizar(items:Item[]) {
  const [rows]:any=await db.query("SELECT id,nombre,referencia,precio_venta,cantidad FROM piloto_catalogo_a WHERE id IN (?) ORDER BY id",[items.map(i=>i.id)]);
  if(rows.length!==items.length)return null;
  let total=0n;
  const lineas=rows.map(r=>{
    const cantidad=items.find(i=>i.id===r.id)!.cantidad;
    if(cantidad>r.cantidad || Number(r.precio_venta)<0)return null;
    const subtotal=BigInt(r.precio_venta.replace(".",""))*BigInt(cantidad);
    total+=subtotal;
    return {id:r.id,nombre:r.nombre,referencia:r.referencia,precio:r.precio_venta,cantidad,subtotal:subtotal.toString()};
  });
  return lineas.includes(null)?null:{lineas,total_centavos:total.toString()};
}
router.post(["/cotizacion","/pedidos"],async(req,res)=>{
  const items=req.body?.items as Item[];
  if(!Array.isArray(items)||!items.length||items.length>40||items.some(i=>!i||!Number.isSafeInteger(i.id)||i.id<1||!Number.isSafeInteger(i.cantidad)||i.cantidad<1)||new Set(items.map(i=>i.id)).size!==items.length){
    res.status(400).json({error:"Revisa los productos y las cantidades del carrito."});return;
  }
  const guardar=req.path==="/pedidos", intento=req.body.intento;
  if(guardar&&!refValida(intento)){res.status(400).json({error:"Identificador de pedido inválido."});return;}
  const huella=createHash("sha256").update(JSON.stringify(items.map(i=>[i.id,i.cantidad]).sort((a,b)=>a[0]-b[0]))).digest("hex");
  const recuperar=async()=>{
    const [rows]:any=await db.execute("SELECT comprobante,huella FROM piloto_pedidos_a WHERE intento=?",[intento]);
    if(!rows.length)return false;
    if(rows[0].huella===huella)res.json({comprobante:rows[0].comprobante});
    else res.status(409).json({error:"Este intento ya corresponde a otro carrito."});
    return true;
  };
  if(guardar&&await recuperar())return;
  const cotizacion=await cotizar(items);
  if(!cotizacion){res.status(409).json({error:"El catálogo cambió o la cantidad supera las existencias. Revisa el carrito."});return;}
  if(!guardar){res.json(cotizacion);return;}
  const comprobante=randomBytes(24).toString("hex");
  try{
    await db.execute("INSERT INTO piloto_pedidos_a (intento,comprobante,huella,lineas,total_centavos) VALUES (?,?,?,?,?)",
      [intento,comprobante,huella,JSON.stringify(cotizacion.lineas),cotizacion.total_centavos]);
  }catch(e:any){if(e.code==="ER_DUP_ENTRY"&&await recuperar())return;throw e;}
  res.status(201).json({comprobante});
});
router.get("/pedidos/:ref",async(req,res)=>{
  if(!refValida(req.params.ref)){res.sendStatus(404);return;}
  const [rows]:any=await db.execute("SELECT comprobante,lineas,total_centavos FROM piloto_pedidos_a WHERE comprobante=?",[req.params.ref]);
  if(!rows.length){res.sendStatus(404);return;}
  res.json({...rows[0],lineas:typeof rows[0].lineas==="string"?JSON.parse(rows[0].lineas):rows[0].lineas});
});
router.use("/gestion",(req,res,next)=>{
  let key="";
  try{key=readFileSync(join(process.env.LOCALAPPDATA||"", "ImpulsaMariaDB","operador-local.key"),"utf8").trim();}catch{/* Sin acceso configurado. */}
  if(!key||req.headers.authorization!=="Bearer "+key){res.status(403).json({error:"Abre el acceso privado local de la bandeja."});return;}
  next();
});
router.get("/gestion/pedidos",async(req,res)=>{
  const where=req.query.vista==="pendientes"?" WHERE revisado_en IS NULL":"";
  const [counts]:any=await db.query("SELECT COUNT(*) total,COUNT(*)-COUNT(revisado_en) pendientes FROM piloto_pedidos_a");
  const paginas=Math.max(1,Math.ceil((where?counts[0].pendientes:counts[0].total)/20));
  const pagina=Math.max(1,Math.min(paginas,Math.trunc(Number(req.query.p))||1));
  const [pedidos]=await db.query("SELECT comprobante,creado,revisado_en,total_centavos FROM piloto_pedidos_a"+where+" ORDER BY creado DESC,comprobante DESC LIMIT 20 OFFSET ?",[(pagina-1)*20]);
  res.json({...counts[0],pagina,paginas,pedidos});
});
router.get("/gestion/seleccion",async(req,res)=>{
  const q=String(req.query.q||"").trim().slice(0,100);
  const from=`FROM piloto_catalogo_a p LEFT JOIN piloto_seleccion_a s ON s.producto_id=p.id
    WHERE (LOCATE(?,p.nombre)>0 OR LOCATE(?,p.referencia)>0)${req.query.vista==="seleccion"?" AND s.producto_id IS NOT NULL":""}`;
  const [counts]:any=await db.execute(`SELECT COUNT(*) total ${from}`,[q,q]);
  const total=Number(counts[0].total),paginas=Math.max(1,Math.ceil(total/24));
  const pagina=Math.max(1,Math.min(paginas,Math.trunc(Number(req.query.p))||1));
  const [productos]=await db.query(`SELECT p.id,p.nombre,p.referencia,p.categoria,p.precio_venta,
    p.cantidad>0 disponible,s.producto_id IS NOT NULL seleccionado ${from} ORDER BY p.nombre,p.id LIMIT 24 OFFSET ?`,[q,q,(pagina-1)*24]);
  res.json({productos,pagina,paginas,total});
});
router.put("/gestion/seleccion/:id",async(req,res)=>{
  const id=Number(req.params.id),seleccionar=req.body?.seleccionar;
  if(!Number.isSafeInteger(id)||id<1||typeof seleccionar!=="boolean"){res.sendStatus(400);return;}
  const [producto]:any=await db.execute("SELECT id FROM piloto_catalogo_a WHERE id=?",[id]);
  if(!producto.length){res.sendStatus(404);return;}
  if(seleccionar)await db.execute("INSERT INTO piloto_seleccion_a (producto_id) VALUES (?) ON DUPLICATE KEY UPDATE producto_id=VALUES(producto_id)",[id]);
  else await db.execute("DELETE FROM piloto_seleccion_a WHERE producto_id=?",[id]);
  res.sendStatus(204);
});
router.post("/gestion/pedidos/:ref/revisar",async(req,res)=>{
  if(!refValida(req.params.ref)){res.sendStatus(404);return;}
  const [result]:any=await db.execute("UPDATE piloto_pedidos_a SET revisado_en=COALESCE(revisado_en,CURRENT_TIMESTAMP) WHERE comprobante=?",[req.params.ref]);
  if(!result.affectedRows){res.sendStatus(404);return;}res.sendStatus(204);
});
router.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  console.error("Error de tienda piloto:",err.code||"consulta");
  res.status(503).json({error:"No se pudo consultar la tienda local."});
});
export default router;
