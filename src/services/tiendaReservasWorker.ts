import pool from "../conection";
import { liberarStockPedido } from "./liberarStockPedido";

let intervalHandle: NodeJS.Timeout | null = null;

export async function liberarReservasVencidas(io?: any): Promise<number> {
  const db=pool.promise();
  // El límite aplica a pedidos, nunca a sus líneas. La selección no autoriza
  // la reposición: la vigencia y el estado se vuelven a leer bajo bloqueo.
  const [candidatos]:any=await db.query(`SELECT id,empresa_id FROM tienda_pedidos
    WHERE estado='pendiente' AND fecha_limite_pago<=NOW() ORDER BY fecha_limite_pago,id LIMIT 50`);
  let total=0;
  for(const {id,empresa_id} of candidatos){
    const conn=await db.getConnection();
    try{
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      const [rows]:any=await conn.execute(`SELECT codigo_orden FROM tienda_pedidos WHERE id=? AND empresa_id=?
        AND estado='pendiente' AND fecha_limite_pago<=NOW() FOR UPDATE`,[id,empresa_id]);
      if(!rows.length){await conn.rollback();continue;}
      const codigo=rows[0].codigo_orden;
      const n=await liberarStockPedido(conn,id,empresa_id,codigo,"liberada");
      await conn.execute("UPDATE tienda_pedidos SET estado='cancelado' WHERE id=? AND empresa_id=?",[id,empresa_id]);
      await conn.execute(`INSERT INTO tienda_auditoria (empresa_id,entidad,entidad_id,accion,actor_tipo,detalle)
        VALUES (?,'pedido',?,'expiracion_automatica_reserva','sistema',?)`,[empresa_id,id,JSON.stringify({codigo_orden:codigo,reservas_liberadas:n})]);
      await conn.commit();
      total+=n;
      try{io?.to(`empresa_${empresa_id}`).emit("pedido_estado_actualizado",{pedido_id:id,codigo_orden:codigo,nuevo_estado:"cancelado",motivo:"Expiración de reserva automática"});}catch{ /* Ya se confirmó la transacción. */ }
    }catch(e){
      await conn.rollback();
      console.error(`[WORKER_RESERVAS] Error liberando pedido ${id}:`,e);
    }finally{conn.release();}
  }
  return total;
}

export function iniciarWorkerReservas(io?: any, intervaloMs=5*60*1000){
  if(intervalHandle)return;
  let enCurso=false;
  const ciclo=async()=>{
    if(enCurso)return;
    enCurso=true;
    try{await liberarReservasVencidas(io);}catch(e){console.error("[WORKER_RESERVAS] Error del ciclo:",e);}
    finally{enCurso=false;}
  };
  void ciclo();
  intervalHandle=setInterval(ciclo,intervaloMs);
}
export function detenerWorkerReservas(){
  if(intervalHandle)clearInterval(intervalHandle);
  intervalHandle=null;
}
