import pool from "../conection";

let intervalHandle: NodeJS.Timeout | null = null;

export async function liberarReservasVencidas(io?: any): Promise<number> {
  const db = pool.promise();
  let conn: any = null;
  let totalLiberadas = 0;

  try {
    // 1. Buscar reservas activas cuya fecha de expiración ya pasó y cuyo pedido sigue pendiente
    const [vencidas]: any = await db.query(
      `SELECT r.id as reserva_id, r.empresa_id, r.pedido_id, r.producto_id, r.cantidad,
              p.codigo_orden
       FROM tienda_reservas r
       JOIN tienda_pedidos p ON p.id = r.pedido_id
       WHERE r.estado = 'activa' 
         AND r.expira_en < NOW() 
         AND p.estado = 'pendiente'
       LIMIT 50`
    );

    if (!vencidas || vencidas.length === 0) {
      return 0;
    }

    conn = await pool.promise().getConnection();

    for (const item of vencidas) {
      try {
        await conn.beginTransaction();

        // Marcar reserva como liberada
        await conn.query(
          "UPDATE tienda_reservas SET estado = 'liberada' WHERE id = ? AND estado = 'activa'",
          [item.reserva_id]
        );

        // Restituir inventario al producto
        await conn.query(
          "UPDATE productos SET cantidad = cantidad + ? WHERE id = ? AND empresa_id = ?",
          [item.cantidad, item.producto_id, item.empresa_id]
        );

        // Cancelar pedido por vencimiento de tiempo
        await conn.query(
          "UPDATE tienda_pedidos SET estado = 'cancelado' WHERE id = ? AND estado = 'pendiente'",
          [item.pedido_id]
        );

        // Registro de auditoría
        await conn.query(
          `INSERT INTO tienda_auditoria (empresa_id, entidad, entidad_id, accion, actor_tipo, detalle)
           VALUES (?, 'pedido', ?, 'expiracion_automatica_reserva', 'sistema', ?)`,
          [
            item.empresa_id,
            item.pedido_id,
            JSON.stringify({
              motivo: "Tiempo límite de pago expirado sin comprobante",
              codigo_orden: item.codigo_orden,
              producto_id: item.producto_id,
              cantidad_liberada: item.cantidad
            })
          ]
        );

        await conn.commit();
        totalLiberadas++;

        // Notificar al POS en tiempo real
        if (io) {
          try {
            io.to(`empresa_${item.empresa_id}`).emit("pedido_estado_actualizado", {
              pedido_id: item.pedido_id,
              codigo_orden: item.codigo_orden,
              nuevo_estado: "cancelado",
              motivo: "Expiración de reserva automática"
            });
          } catch (sockErr) {
            // No bloquear por socket
          }
        }
      } catch (itemErr) {
        await conn.rollback();
        console.error(`[WORKER_RESERVAS] Error liberando reserva ${item.reserva_id}:`, itemErr);
      }
    }
  } catch (err: any) {
    console.error("[WORKER_RESERVAS] Error general en liberarReservasVencidas:", err);
  } finally {
    if (conn) conn.release();
  }

  return totalLiberadas;
}

export function iniciarWorkerReservas(io?: any, intervaloMs = 5 * 60 * 1000) {
  if (intervalHandle) return;

  console.log("[WORKER_RESERVAS] Iniciado worker de liberación de reservas vencidas.");
  // Ejecutar inmediatamente al inicio
  liberarReservasVencidas(io).catch(() => {});

  // Programar ejecución periódica
  intervalHandle = setInterval(() => {
    liberarReservasVencidas(io).catch((err) => {
      console.error("[WORKER_RESERVAS] Error en ciclo periódico:", err);
    });
  }, intervaloMs);
}

export function detenerWorkerReservas() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[WORKER_RESERVAS] Worker de reservas detenido.");
  }
}
