import type { PoolConnection } from "mysql2/promise";

// Requiere transacción abierta y bloqueo FOR UPDATE del pedido por el llamador.
export async function liberarStockPedido(conn: PoolConnection, pedidoId: number, empresa: number, codigo: string, estado: "liberada" | "cancelada") {
  const [reservas]: any = await conn.query(`SELECT id, producto_id, cantidad FROM tienda_reservas
    WHERE pedido_id=? AND empresa_id=? AND estado='activa' ORDER BY producto_id,id FOR UPDATE`,[pedidoId,empresa]);
  for (const r of reservas) {
    const [productos]: any = await conn.query("SELECT cantidad FROM productos WHERE id=? AND empresa_id=? FOR UPDATE",[r.producto_id,empresa]);
    if (!productos.length || r.cantidad <= 0) throw new Error("No se puede reponer la reserva: revisar inventario.");
    const antes=Number(productos[0].cantidad);
    const [cambio]: any = await conn.execute("UPDATE tienda_reservas SET estado=? WHERE id=? AND estado='activa'",[estado,r.id]);
    if (cambio.affectedRows!==1) throw new Error("Cambió la reserva durante la liberación.");
    await conn.execute("UPDATE productos SET cantidad=cantidad+? WHERE id=? AND empresa_id=?",[r.cantidad,r.producto_id,empresa]);
    await conn.execute(`INSERT INTO kardex (empresa_id,producto_id,tipo_movimiento,motivo,referencia,cantidad_antes,cantidad_modificada,cantidad_despues)
      VALUES (?,?,'ENTRADA',?,?,?,?,?)`,[empresa,r.producto_id,estado==="liberada"?"Vencimiento pedido web":"Cancelación pedido web",codigo,antes,r.cantidad,antes+r.cantidad]);
  }
  return reservas.length as number;
}
